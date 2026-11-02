// State transitions for work units. Every function writes one event row describing what it did.
// Call these inside tx() so the unit updates and the event commit together.
import type { Db } from './db';
import { HttpError } from './db';
import type { EventKind, UnitState } from '../../shared/types';

export interface StepRow {
  step_key: string;
  ordinal: number;
  name: string;
  mode: 'auto' | 'manual';
  role: string | null;
  sla_days: number | null;
  task_label: string | null;
  exclude_reason: string | null;
}

export interface PipelineRow {
  pipeline_id: string;
  study_id: string;
  modality: string;
  engine: string;
  version: string;
  source: string;
}

// Pipeline definitions change rarely (config:load); cache them briefly per process.
const pipelineCache = new Map<string, { p: PipelineRow; steps: StepRow[]; at: number }>();
const CACHE_MS = 30_000;

export async function getPipeline(db: Db, pipelineId: string) {
  const hit = pipelineCache.get(pipelineId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const p = await db.query<PipelineRow>(
    `SELECT p.pipeline_id, p.study_id, p.modality, p.engine, p.version, s.source
       FROM pipeline p JOIN study s USING (study_id) WHERE p.pipeline_id = $1`,
    [pipelineId],
  );
  if (!p.rowCount) throw new HttpError(404, `Unknown pipeline "${pipelineId}"`);
  const steps = await db.query<StepRow>(
    `SELECT step_key, ordinal, name, mode, role, sla_days, task_label, exclude_reason
       FROM step WHERE pipeline_id = $1 ORDER BY ordinal`,
    [pipelineId],
  );
  const entry = { p: p.rows[0], steps: steps.rows, at: Date.now() };
  pipelineCache.set(pipelineId, entry);
  return entry;
}

function stepOf(steps: StepRow[], key: string): StepRow {
  const s = steps.find((x) => x.step_key === key);
  if (!s) throw new HttpError(404, `Unknown step "${key}"`);
  return s;
}

interface EventInput {
  pipelineId: string | null;
  stepKey: string | null;
  unitIds: number[];
  fromState?: UnitState | null;
  toState?: UnitState | null;
  kind: EventKind;
  actor: string;
  actorKind: 'pipeline' | 'person' | 'system';
  softwareVersion?: string | null;
  reasonCode?: string | null;
  note: string;
  deliverableId?: string | null;
  itemId?: string | null;
  runId?: number | null;
}

export async function logEvent(db: Db, e: EventInput, n = e.unitIds.length): Promise<void> {
  await db.query(
    `INSERT INTO event (pipeline_id, step_key, unit_ids, n, from_state, to_state, kind,
                        actor, actor_kind, software_version, reason_code, note, deliverable_id, item_id, run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [e.pipelineId, e.stepKey, e.unitIds, n, e.fromState ?? null, e.toState ?? null, e.kind,
     e.actor, e.actorKind, e.softwareVersion ?? null, e.reasonCode ?? null, e.note,
     e.deliverableId ?? null, e.itemId ?? null, e.runId ?? null],
  );
}

const toIds = (rows: { unit_id: string | number }[]) => rows.map((r) => Number(r.unit_id));
const plural = (n: number) => `${n.toLocaleString('en-US')} unit${n === 1 ? '' : 's'}`;

/** Move units to the next step's queue, or to released after the last step. */
export async function advance(db: Db, pipelineId: string, stepKey: string, unitIds: number[]) {
  if (!unitIds.length) return;
  const { steps } = await getPipeline(db, pipelineId);
  const idx = steps.findIndex((s) => s.step_key === stepKey);
  const next = steps[idx + 1];
  if (next) {
    await db.query(
      `UPDATE work_unit SET step_key = $2, state = 'queued', attempts = 0, updated_at = now() WHERE unit_id = ANY($1)`,
      [unitIds, next.step_key],
    );
  } else {
    await db.query(
      `UPDATE work_unit SET state = 'released', updated_at = now() WHERE unit_id = ANY($1)`,
      [unitIds],
    );
  }
}

/** Source adapter delivered `k` expected units. */
export async function receive(db: Db, pipelineId: string, k: number) {
  const { p, steps } = await getPipeline(db, pipelineId);
  const first = steps[0];
  const r = await db.query(
    `UPDATE work_unit SET state = 'queued', step_key = $2, updated_at = now()
      WHERE unit_id IN (SELECT unit_id FROM work_unit WHERE pipeline_id = $1 AND state = 'expected'
                         ORDER BY unit_id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING unit_id`,
    [pipelineId, first.step_key, k],
  );
  const ids = toIds(r.rows);
  if (!ids.length) return 0;
  await logEvent(db, {
    pipelineId, stepKey: first.step_key, unitIds: ids, fromState: 'expected', toState: 'queued',
    kind: 'arrive', actor: p.source, actorKind: 'system',
    note: `${plural(ids.length)} received, queued for ${first.name}`,
  });
  return ids.length;
}

/** Workflow engine picked up `k` queued units at an automated step. */
export async function startStep(db: Db, pipelineId: string, stepKey: string, k: number) {
  const { p, steps } = await getPipeline(db, pipelineId);
  const step = stepOf(steps, stepKey);
  const r = await db.query(
    `UPDATE work_unit SET state = 'running', updated_at = now()
      WHERE unit_id IN (SELECT unit_id FROM work_unit WHERE pipeline_id = $1 AND step_key = $2 AND state = 'queued'
                         ORDER BY unit_id LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING unit_id`,
    [pipelineId, stepKey, k],
  );
  const ids = toIds(r.rows);
  if (!ids.length) return 0;
  await logEvent(db, {
    pipelineId, stepKey, unitIds: ids, fromState: 'queued', toState: 'running', kind: 'start',
    actor: `${p.engine}@${p.version}`, actorKind: 'pipeline', softwareVersion: p.version,
    note: `${step.name}: started ${plural(ids.length)}`,
  });
  return ids.length;
}

/** Workflow engine finished `k` running units; `failIds` of them failed. */
export async function finishStep(
  db: Db, pipelineId: string, stepKey: string, k: number, failShare: number, reasonCode: string,
) {
  const { p, steps } = await getPipeline(db, pipelineId);
  const step = stepOf(steps, stepKey);
  const r = await db.query(
    `SELECT unit_id FROM work_unit WHERE pipeline_id = $1 AND step_key = $2 AND state = 'running'
      ORDER BY unit_id LIMIT $3 FOR UPDATE SKIP LOCKED`,
    [pipelineId, stepKey, k],
  );
  const ids = toIds(r.rows);
  if (!ids.length) return 0;
  const nFail = failShare > 0 ? Math.max(1, Math.round(ids.length * failShare)) : 0;
  const failed = ids.slice(0, nFail);
  const passed = ids.slice(nFail);
  const actor = `${p.engine}@${p.version}`;
  if (passed.length) {
    await advance(db, pipelineId, stepKey, passed);
    await logEvent(db, {
      pipelineId, stepKey, unitIds: passed, fromState: 'running', toState: 'queued', kind: 'done',
      actor, actorKind: 'pipeline', softwareVersion: p.version,
      note: `${step.name}: ${plural(passed.length)} completed`,
    });
  }
  if (failed.length) {
    await db.query(`UPDATE work_unit SET state = 'failed', attempts = attempts + 1, updated_at = now() WHERE unit_id = ANY($1)`, [failed]);
    await logEvent(db, {
      pipelineId, stepKey, unitIds: failed, fromState: 'running', toState: 'failed', kind: 'fail',
      actor, actorKind: 'pipeline', softwareVersion: p.version, reasonCode,
      note: `${step.name}: ${plural(failed.length)} failed (${reasonCode})`,
    });
  }
  return ids.length;
}

/** Requeue every failed unit at a step. */
export async function retryFailed(db: Db, pipelineId: string, stepKey: string, actor: string) {
  const { steps } = await getPipeline(db, pipelineId);
  const step = stepOf(steps, stepKey);
  const r = await db.query(
    `UPDATE work_unit SET state = 'queued', updated_at = now()
      WHERE pipeline_id = $1 AND step_key = $2 AND state = 'failed' RETURNING unit_id`,
    [pipelineId, stepKey],
  );
  const ids = toIds(r.rows);
  if (!ids.length) return 0;
  await logEvent(db, {
    pipelineId, stepKey, unitIds: ids, fromState: 'failed', toState: 'queued', kind: 'retry',
    actor, actorKind: 'person', note: `${step.name}: ${plural(ids.length)} requeued after failure`,
  });
  return ids.length;
}

/** Group queued units at a manual step that are not yet in an open batch into a new task. */
export async function createTask(
  db: Db, pipelineId: string, stepKey: string, size: number,
  assignee: string | null = null, createdAt: Date = new Date(),
) {
  const { steps } = await getPipeline(db, pipelineId);
  const step = stepOf(steps, stepKey);
  if (step.mode !== 'manual') throw new HttpError(400, `${step.name} is automated; batches are only for manual steps`);
  const r = await db.query(
    `SELECT w.unit_id FROM work_unit w
      WHERE w.pipeline_id = $1 AND w.step_key = $2 AND w.state = 'queued'
        AND NOT EXISTS (SELECT 1 FROM task t WHERE t.status = 'open' AND t.unit_ids @> ARRAY[w.unit_id])
      ORDER BY w.unit_id LIMIT $3`,
    [pipelineId, stepKey, size],
  );
  const ids = toIds(r.rows);
  if (!ids.length) return null;
  const due = new Date(createdAt.getTime() + (step.sla_days ?? 7) * 864e5);
  const t = await db.query<{ task_id: string }>(
    `INSERT INTO task (pipeline_id, step_key, unit_ids, assignee, created_at, due_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING task_id`,
    [pipelineId, stepKey, ids, assignee, createdAt, due],
  );
  await logEvent(db, {
    pipelineId, stepKey, unitIds: ids, kind: 'task', actor: 'tracker', actorKind: 'system',
    note: `New ${step.task_label ?? step.name} batch of ${plural(ids.length)}` +
      (assignee ? ` assigned to ${assignee}` : ' waiting for a reviewer'),
  });
  return Number(t.rows[0].task_id);
}

interface TaskRow {
  task_id: string; pipeline_id: string; step_key: string; unit_ids: string[];
  assignee: string | null; status: string;
}

async function lockOpenTask(db: Db, taskId: number): Promise<TaskRow> {
  const r = await db.query<TaskRow>(`SELECT * FROM task WHERE task_id = $1 FOR UPDATE`, [taskId]);
  if (!r.rowCount) throw new HttpError(404, `Batch ${taskId} does not exist`);
  if (r.rows[0].status !== 'open') throw new HttpError(409, `Batch ${taskId} is already closed`);
  return r.rows[0];
}

export async function assignTask(db: Db, taskId: number, assignee: string | null, actor: string) {
  const t = await lockOpenTask(db, taskId);
  if (assignee) {
    const p = await db.query(`SELECT 1 FROM person WHERE name = $1`, [assignee]);
    if (!p.rowCount) throw new HttpError(400, `Unknown person "${assignee}"`);
  }
  await db.query(`UPDATE task SET assignee = $2 WHERE task_id = $1`, [taskId, assignee]);
  const { steps } = await getPipeline(db, t.pipeline_id);
  const label = stepOf(steps, t.step_key).task_label ?? t.step_key;
  await logEvent(db, {
    pipelineId: t.pipeline_id, stepKey: t.step_key, unitIds: [], kind: 'assign', actor, actorKind: 'person',
    note: assignee === actor ? `${actor} claimed ${label} batch #${taskId}`
      : assignee ? `${label} batch #${taskId} assigned to ${assignee}`
      : `${label} batch #${taskId} returned to the pool`,
  }, t.unit_ids.length);
}

/**
 * A person passed a batch. `excludeShare` of the units are excluded with the step's reason code,
 * the rest advance. Units that have already moved on are skipped.
 */
export async function completeTask(db: Db, taskId: number, actor: string, excludeShare = 0.03) {
  const t = await lockOpenTask(db, taskId);
  const { steps } = await getPipeline(db, t.pipeline_id);
  const step = stepOf(steps, t.step_key);
  const r = await db.query(
    `SELECT unit_id FROM work_unit WHERE unit_id = ANY($1) AND step_key = $2 AND state = 'queued'
      ORDER BY unit_id FOR UPDATE`,
    [t.unit_ids, t.step_key],
  );
  const ids = toIds(r.rows);
  const nEx = Math.round(ids.length * excludeShare);
  const excluded = ids.slice(0, nEx);
  const passed = ids.slice(nEx);
  await advance(db, t.pipeline_id, t.step_key, passed);
  if (excluded.length) {
    await db.query(`UPDATE work_unit SET state = 'excluded', updated_at = now() WHERE unit_id = ANY($1)`, [excluded]);
    await logEvent(db, {
      pipelineId: t.pipeline_id, stepKey: t.step_key, unitIds: excluded, fromState: 'queued', toState: 'excluded',
      kind: 'decision', actor, actorKind: 'person', reasonCode: step.exclude_reason,
      note: `${step.name}: ${plural(excluded.length)} excluded (${step.exclude_reason ?? 'no reason code'})`,
    });
  }
  await db.query(
    `UPDATE task SET status = 'done', closed_at = now(), closed_by = $2, assignee = COALESCE(assignee, $2)
      WHERE task_id = $1`,
    [taskId, actor],
  );
  await logEvent(db, {
    pipelineId: t.pipeline_id, stepKey: t.step_key, unitIds: passed, fromState: 'queued', toState: 'queued',
    kind: 'decision', actor, actorKind: 'person',
    note: `${step.name}: ${plural(passed.length)} passed (batch #${taskId})`,
  });
  return { passed: passed.length, excluded: excluded.length };
}

// ---------- generic transition used by workflow engines (POST /api/events) ----------

export interface TransitionInput {
  pipelineId: string;
  stepKey: string;
  unitIds?: number[];
  sessionIds?: string[];
  toState: 'running' | 'passed' | 'failed' | 'queued' | 'excluded';
  actor: string;
  actorKind?: 'pipeline' | 'person' | 'system';
  softwareVersion?: string;
  reasonCode?: string;
  note?: string;
}

const ALLOWED_FROM: Record<TransitionInput['toState'], UnitState[]> = {
  running: ['queued'],
  passed: ['queued', 'running'],
  failed: ['queued', 'running'],
  queued: ['failed', 'running'],
  excluded: ['queued', 'running', 'failed'],
};

export async function transition(db: Db, input: TransitionInput) {
  const { steps } = await getPipeline(db, input.pipelineId);
  const step = stepOf(steps, input.stepKey);
  if (!ALLOWED_FROM[input.toState]) throw new HttpError(400, `to_state must be one of ${Object.keys(ALLOWED_FROM).join(', ')}`);
  if ((input.toState === 'excluded' || input.toState === 'failed') && !input.reasonCode) {
    throw new HttpError(400, `reason_code is required when to_state is "${input.toState}"`);
  }
  const r = await db.query<{ unit_id: string; state: UnitState }>(
    `SELECT unit_id, state FROM work_unit
      WHERE pipeline_id = $1 AND step_key = $2
        AND (unit_id = ANY($3::bigint[]) OR session_id = ANY($4::text[]))
      FOR UPDATE`,
    [input.pipelineId, input.stepKey, input.unitIds ?? [], input.sessionIds ?? []],
  );
  const ok = r.rows.filter((x) => ALLOWED_FROM[input.toState].includes(x.state));
  const ids = toIds(ok);
  const requested = (input.unitIds?.length ?? 0) + (input.sessionIds?.length ?? 0);
  if (ids.length) {
    const actorKind = input.actorKind ?? 'pipeline';
    let kind: EventKind;
    if (input.toState === 'passed') {
      await advance(db, input.pipelineId, input.stepKey, ids);
      kind = actorKind === 'person' ? 'decision' : 'done';
    } else {
      await db.query(
        `UPDATE work_unit SET state = $2, attempts = attempts + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END, updated_at = now()
          WHERE unit_id = ANY($1)`, [ids, input.toState]);
      kind = input.toState === 'running' ? 'start' : input.toState === 'failed' ? 'fail'
        : input.toState === 'queued' ? 'retry' : 'decision';
    }
    await logEvent(db, {
      pipelineId: input.pipelineId, stepKey: input.stepKey, unitIds: ids,
      fromState: ok.length === 1 ? ok[0].state : null,
      toState: input.toState === 'passed' ? 'queued' : input.toState,
      kind, actor: input.actor, actorKind, softwareVersion: input.softwareVersion,
      reasonCode: input.reasonCode,
      note: input.note ?? `${step.name}: ${plural(ids.length)} ${input.toState}${input.reasonCode ? ` (${input.reasonCode})` : ''}`,
    });
  }
  return { updated: ids.length, skipped: requested - ids.length };
}
