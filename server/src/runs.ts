// Worker-facing side of runs: claim the next queued run, look it up, report the outcome.
// Handles both deliverable runs (one work item) and processing runs (a batch of units at a pipeline step).
import { HttpError, type Db } from './db';
import { advance, getPipeline, logEvent } from './services';
import { runFromRow } from './plan';
import { renderCommand } from '../../shared/plan';

export interface ClaimedRun {
  runId: number;
  kind: 'deliverable' | 'processing';
  engine: string;
  command: string;
  study: string | null;
  // deliverable runs
  workflowId?: string; itemId?: string; itemTitle?: string; deliverableId?: string;
  // processing runs
  pipelineId?: string; stepKey?: string; sessionIds?: string[]; unitIds?: number[];
}

const plural = (n: number) => `${n.toLocaleString('en-US')} unit${n === 1 ? '' : 's'}`;

function renderStep(template: string | null, engine: string, ctx: { pipeline: string; step: string; study: string; runId: number }) {
  return (template ?? `${engine} --pipeline {pipeline} --step {step} --run {run_id}`)
    .replaceAll('{pipeline}', ctx.pipeline).replaceAll('{step}', ctx.step)
    .replaceAll('{study}', ctx.study).replaceAll('{run_id}', String(ctx.runId));
}

async function describe(db: Db, runId: number): Promise<ClaimedRun> {
  const r = await db.query(
    `SELECT r.*, w.command AS wf_command, i.title AS item_title, i.deliverable_id, d.study_id AS d_study,
            s.command AS step_command, p.study_id AS p_study
       FROM workflow_run r
       LEFT JOIN workflow w ON w.workflow_id = r.workflow_id
       LEFT JOIN work_item i ON i.item_id = r.item_id
       LEFT JOIN deliverable d ON d.deliverable_id = i.deliverable_id
       LEFT JOIN step s ON s.pipeline_id = r.pipeline_id AND s.step_key = r.step_key
       LEFT JOIN pipeline p ON p.pipeline_id = r.pipeline_id
      WHERE r.run_id = $1`,
    [runId],
  );
  if (!r.rowCount) throw new HttpError(404, `Run ${runId} does not exist`);
  const x = r.rows[0];
  if (x.item_id) {
    return {
      runId, kind: 'deliverable', engine: x.engine, study: x.d_study,
      workflowId: x.workflow_id, itemId: x.item_id, itemTitle: x.item_title, deliverableId: x.deliverable_id,
      command: renderCommand(x.wf_command, { study: x.d_study, deliverable: x.deliverable_id, item: x.item_id, runId }),
    };
  }
  const ids = (x.unit_ids as string[]).map(Number);
  const sessions = await db.query<{ session_id: string }>(
    'SELECT session_id FROM work_unit WHERE unit_id = ANY($1) ORDER BY unit_id', [ids]);
  return {
    runId, kind: 'processing', engine: x.engine, study: x.p_study, pipelineId: x.pipeline_id, stepKey: x.step_key,
    unitIds: ids, sessionIds: sessions.rows.map((s) => s.session_id),
    command: renderStep(x.step_command, x.engine, { pipeline: x.pipeline_id, step: x.step_key, study: x.p_study, runId }),
  };
}

export async function getRun(db: Db, runId: number) {
  const r = await db.query('SELECT * FROM workflow_run WHERE run_id = $1', [runId]);
  if (!r.rowCount) throw new HttpError(404, `Run ${runId} does not exist`);
  return { ...runFromRow(r.rows[0]), ...(await describe(db, runId)) };
}

/**
 * A worker asks for the oldest queued run it can execute. `engines` filters by exact engine name;
 * a trailing * matches a prefix ("nextflow:*"). Returns null when there is nothing to do.
 */
export async function claimRun(db: Db, worker: string, engines: string[] | null): Promise<ClaimedRun | null> {
  const patterns = engines?.map((e) => e.replace(/[%_]/g, '\\$&').replace(/\*$/, '%')) ?? null;
  const r = await db.query(
    `SELECT run_id, item_id, pipeline_id, step_key, unit_ids FROM workflow_run
      WHERE status = 'queued' AND ($1::text[] IS NULL OR engine LIKE ANY($1))
      ORDER BY (item_id IS NULL), created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, // deliverable runs first
    [patterns],
  );
  if (!r.rowCount) return null;
  const x = r.rows[0];
  const runId = Number(x.run_id);
  await db.query(`UPDATE workflow_run SET status = 'running', started_at = now(), worker = $2 WHERE run_id = $1`, [runId, worker]);
  if (x.item_id) {
    const c = await describe(db, runId);
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'run', actor: worker, actorKind: 'pipeline',
      note: `${c.workflowId} started for “${c.itemTitle}”`, deliverableId: c.deliverableId, itemId: c.itemId, runId,
    });
    return c;
  }
  // Processing run: units still waiting at the step start running; any that moved on are dropped from the batch.
  const started = await db.query<{ unit_id: string }>(
    `UPDATE work_unit SET state = 'running', updated_at = now()
      WHERE unit_id = ANY($1) AND pipeline_id = $2 AND step_key = $3 AND state = 'queued' RETURNING unit_id`,
    [x.unit_ids, x.pipeline_id, x.step_key],
  );
  const ids = started.rows.map((u) => Number(u.unit_id));
  await db.query('UPDATE workflow_run SET unit_ids = $2 WHERE run_id = $1', [runId, ids]);
  const { p, steps } = await getPipeline(db, x.pipeline_id);
  const step = steps.find((s) => s.step_key === x.step_key);
  await logEvent(db, {
    pipelineId: x.pipeline_id, stepKey: x.step_key, unitIds: ids, fromState: 'queued', toState: 'running',
    kind: 'start', actor: worker, actorKind: 'pipeline', softwareVersion: p.version, runId,
    note: `${step?.name ?? x.step_key}: started ${plural(ids.length)} (run #${runId})`,
  });
  return describe(db, runId);
}

export interface FinishInput {
  status: 'succeeded' | 'failed';
  worker: string;
  message?: string | null;
  /** Processing runs: units that failed even though the run as a whole succeeded. */
  failedUnitIds?: number[];
  reasonCode?: string | null;
}

export async function finishRun(db: Db, runId: number, f: FinishInput) {
  const r = await db.query(
    `SELECT r.*, w.name AS wf_name, i.title AS item_title, i.deliverable_id
       FROM workflow_run r
       LEFT JOIN workflow w ON w.workflow_id = r.workflow_id
       LEFT JOIN work_item i ON i.item_id = r.item_id
      WHERE r.run_id = $1 FOR UPDATE OF r`,
    [runId],
  );
  if (!r.rowCount) throw new HttpError(404, `Run ${runId} does not exist`);
  const x = r.rows[0];
  if (x.status !== 'queued' && x.status !== 'running') throw new HttpError(409, `Run ${runId} already finished (${x.status})`);
  await db.query(
    `UPDATE workflow_run SET status = $2, message = $3, finished_at = now(), worker = COALESCE(worker, $4) WHERE run_id = $1`,
    [runId, f.status, f.message ?? null, f.worker],
  );

  if (x.item_id) {
    await db.query(`UPDATE work_item SET status = $2, updated_at = now() WHERE item_id = $1`,
      [x.item_id, f.status === 'succeeded' ? 'done' : 'failed']);
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'run', actor: f.worker, actorKind: 'pipeline',
      note: `${x.wf_name} ${f.status} for “${x.item_title}”${f.message ? `: ${f.message}` : ''}`,
      deliverableId: x.deliverable_id, itemId: x.item_id, runId,
    });
    return { kind: 'deliverable' as const };
  }

  const running = await db.query<{ unit_id: string }>(
    `SELECT unit_id FROM work_unit WHERE unit_id = ANY($1) AND step_key = $2 AND state = 'running' FOR UPDATE`,
    [x.unit_ids, x.step_key],
  );
  const ids = running.rows.map((u) => Number(u.unit_id));
  const failSet = new Set(f.status === 'failed' ? ids : (f.failedUnitIds ?? []).filter((id) => ids.includes(id)));
  const failed = ids.filter((id) => failSet.has(id));
  const passed = ids.filter((id) => !failSet.has(id));
  const { p, steps } = await getPipeline(db, x.pipeline_id);
  const name = steps.find((s) => s.step_key === x.step_key)?.name ?? x.step_key;
  if (passed.length) {
    await advance(db, x.pipeline_id, x.step_key, passed);
    await logEvent(db, {
      pipelineId: x.pipeline_id, stepKey: x.step_key, unitIds: passed, fromState: 'running', toState: 'queued',
      kind: 'done', actor: f.worker, actorKind: 'pipeline', softwareVersion: p.version, runId,
      note: `${name}: ${plural(passed.length)} completed (run #${runId})`,
    });
  }
  if (failed.length) {
    const reason = f.reasonCode ?? 'PROCESSING_ERROR';
    await db.query(`UPDATE work_unit SET state = 'failed', attempts = attempts + 1, updated_at = now() WHERE unit_id = ANY($1)`, [failed]);
    await logEvent(db, {
      pipelineId: x.pipeline_id, stepKey: x.step_key, unitIds: failed, fromState: 'running', toState: 'failed',
      kind: 'fail', actor: f.worker, actorKind: 'pipeline', softwareVersion: p.version, reasonCode: reason, runId,
      note: `${name}: ${plural(failed.length)} failed (${reason})`,
    });
  }
  return { kind: 'processing' as const, passed: passed.length, failed: failed.length };
}
