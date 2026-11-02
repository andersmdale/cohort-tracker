// Deliverables, work items and workflow runs: loading plan.yaml, the scheduler that starts
// automated items when they become ready, and the operations behind the API.
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type pg from 'pg';
import { HttpError, type Db } from './db';
import { logEvent } from './services';
import {
  computePlan, itemsToTrigger, normalizePlan, progressFromPipelines,
  type PlanDoc, type ProgressPipeline, type RawDeliverable, type RawPlan,
} from '../../shared/plan';
import { pathVars } from '../../shared/config';
import { renderPath, type ModalityKey } from '../../shared/catalog';
import type { DeliverableKind, ItemPatch, Raci, WorkflowRun } from '../../shared/types';

export const PLAN_PATH = new URL('../../shared/plan.yaml', import.meta.url);

// ---------- loading plan.yaml ----------

/** Upsert definitions from plan.yaml. Live item status and assignee are kept for items that already exist. */
export async function loadPlanFile(db: pg.PoolClient, opts: { path?: URL | string; prune?: boolean } = {}) {
  const doc = YAML.parse(readFileSync(opts.path ?? PLAN_PATH, 'utf8')) as PlanDoc;
  const [people, pipelines, studies, steps] = await Promise.all([
    db.query<{ name: string }>('SELECT name FROM person'),
    db.query<{ pipeline_id: string }>('SELECT pipeline_id FROM pipeline'),
    db.query<{ study_id: string }>('SELECT study_id FROM study'),
    db.query<{ pipeline_id: string; step_key: string }>('SELECT pipeline_id, step_key FROM step'),
  ]);
  const stepsBy: Record<string, string[]> = {};
  for (const r of steps.rows) (stepsBy[r.pipeline_id] ??= []).push(r.step_key);
  const plan = normalizePlan(doc, {
    people: people.rows.map((r) => r.name),
    pipelines: pipelines.rows.map((r) => r.pipeline_id),
    studies: studies.rows.map((r) => r.study_id),
    steps: stepsBy,
  });

  for (const w of plan.workflows) {
    await db.query(
      `INSERT INTO workflow (workflow_id, name, engine, trigger, maintainer, command, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workflow_id) DO UPDATE SET name = $2, engine = $3, trigger = $4, maintainer = $5,
         command = $6, description = $7`,
      [w.id, w.name, w.engine, w.trigger, w.maintainer, w.command, w.description],
    );
  }
  for (const d of plan.deliverables) {
    await db.query(
      `INSERT INTO deliverable (deliverable_id, title, study_id, kind, description, owner, due_date, sort_order, release)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (deliverable_id) DO UPDATE SET title = $2, study_id = $3, kind = $4, description = $5,
         owner = $6, due_date = $7, sort_order = $8, release = $9`,
      [d.id, d.title, d.study, d.kind, d.description, d.owner, d.dueDate, d.sortOrder, d.release],
    );
  }
  const dIds = plan.deliverables.map((d) => d.id);
  await db.query('DELETE FROM deliverable_dependency WHERE deliverable_id = ANY($1)', [dIds]);
  await db.query('DELETE FROM deliverable_gate WHERE deliverable_id = ANY($1)', [dIds]);
  await db.query('DELETE FROM deliverable_raci WHERE deliverable_id = ANY($1)', [dIds]);
  for (const d of plan.deliverables) {
    for (const dep of d.dependsOn) {
      await db.query('INSERT INTO deliverable_dependency (deliverable_id, depends_on) VALUES ($1,$2)', [d.id, dep]);
    }
    for (const g of d.gates) {
      await db.query('INSERT INTO deliverable_gate (deliverable_id, pipeline_id, step_key, min_released) VALUES ($1,$2,$3,$4)',
        [d.id, g.pipelineId, g.stepKey ?? '', g.threshold]);
    }
    for (const r of d.raci) {
      await db.query('INSERT INTO deliverable_raci (deliverable_id, person, raci) VALUES ($1,$2,$3)', [d.id, r.person, r.role]);
    }
  }
  for (const it of plan.items) {
    await db.query(
      `INSERT INTO work_item (item_id, deliverable_id, ordinal, title, mode, workflow_id, assignee, status, due_date, output_template)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (item_id) DO UPDATE SET deliverable_id = $2, ordinal = $3, title = $4, mode = $5,
         workflow_id = $6, due_date = $9, output_template = $10`,
      [it.id, it.deliverableId, it.ordinal, it.title, it.mode, it.workflowId, it.assignee, it.status, it.dueDate, it.outputTemplate],
    );
  }
  const iIds = plan.items.map((i) => i.id);
  await db.query('DELETE FROM work_item_dependency WHERE item_id = ANY($1)', [iIds]);
  for (const it of plan.items) {
    for (const a of it.after) {
      await db.query('INSERT INTO work_item_dependency (item_id, depends_on) VALUES ($1,$2)', [it.id, a]);
    }
  }
  let pruned = 0;
  if (opts.prune) {
    pruned += (await db.query('DELETE FROM work_item WHERE NOT (item_id = ANY($1))', [iIds])).rowCount ?? 0;
    pruned += (await db.query('DELETE FROM deliverable WHERE NOT (deliverable_id = ANY($1))', [dIds])).rowCount ?? 0;
    const wIds = plan.workflows.map((w) => w.id);
    await db.query('DELETE FROM workflow_run WHERE NOT (workflow_id = ANY($1))', [wIds]);
    pruned += (await db.query('DELETE FROM workflow WHERE NOT (workflow_id = ANY($1))', [wIds])).rowCount ?? 0;
  }
  return { deliverables: plan.deliverables.length, items: plan.items.length, workflows: plan.workflows.length, pruned };
}

// ---------- reading ----------

const iso = (v: Date | null) => (v ? new Date(v).toISOString() : null);

export function runFromRow(r: Record<string, unknown>): WorkflowRun {
  return {
    id: Number(r.run_id), workflowId: (r.workflow_id as string | null) ?? null, itemId: (r.item_id as string | null) ?? null,
    pipelineId: (r.pipeline_id as string | null) ?? null, stepKey: (r.step_key as string | null) ?? null,
    engine: r.engine as string, n: Array.isArray(r.unit_ids) ? r.unit_ids.length : 0,
    status: r.status as WorkflowRun['status'], triggeredBy: r.triggered_by as string,
    worker: (r.worker as string | null) ?? null, message: (r.message as string | null) ?? null,
    createdAt: iso(r.created_at as Date)!, startedAt: iso(r.started_at as Date | null),
    finishedAt: iso(r.finished_at as Date | null),
  };
}

export async function loadRawPlan(db: Db, runLimit = 300): Promise<RawPlan> {
  const [d, deps, gates, raci, items, idep, wfs, runs] = await Promise.all([
    db.query(`SELECT deliverable_id, title, study_id, kind, description, owner, release,
                     to_char(due_date, 'YYYY-MM-DD') AS due, sort_order FROM deliverable`),
    db.query('SELECT deliverable_id, depends_on FROM deliverable_dependency'),
    db.query('SELECT deliverable_id, pipeline_id, step_key, min_released::float8 AS t FROM deliverable_gate ORDER BY pipeline_id'),
    db.query(`SELECT deliverable_id, person, raci FROM deliverable_raci ORDER BY position(raci in 'ARCI'), person`),
    db.query(`SELECT item_id, deliverable_id, ordinal, title, mode, workflow_id, assignee, status,
                     output_template, output_path, to_char(due_date, 'YYYY-MM-DD') AS due FROM work_item`),
    db.query('SELECT item_id, depends_on FROM work_item_dependency'),
    db.query('SELECT * FROM workflow ORDER BY workflow_id'),
    db.query('SELECT * FROM workflow_run ORDER BY run_id DESC LIMIT $1', [runLimit]),
  ]);
  const group = <T,>(rows: Record<string, unknown>[], key: string, map: (r: Record<string, unknown>) => T) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = r[key] as string;
      m.set(k, [...(m.get(k) ?? []), map(r)]);
    }
    return m;
  };
  const depsBy = group(deps.rows, 'deliverable_id', (r) => r.depends_on as string);
  const gatesBy = group(gates.rows, 'deliverable_id', (r) => ({
    pipelineId: r.pipeline_id as string, stepKey: (r.step_key as string) || null, threshold: r.t as number,
  }));
  const raciBy = group(raci.rows, 'deliverable_id', (r) => ({ person: r.person as string, role: r.raci as Raci }));
  const afterBy = group(idep.rows, 'item_id', (r) => r.depends_on as string);
  return {
    deliverables: d.rows.map((r) => ({
      id: r.deliverable_id, title: r.title, study: r.study_id, kind: r.kind as DeliverableKind,
      description: r.description, owner: r.owner, dueDate: r.due, sortOrder: r.sort_order, release: r.release,
      dependsOn: depsBy.get(r.deliverable_id) ?? [], gates: gatesBy.get(r.deliverable_id) ?? [],
      raci: raciBy.get(r.deliverable_id) ?? [],
    })),
    items: items.rows.map((r) => ({
      id: r.item_id, deliverableId: r.deliverable_id, ordinal: r.ordinal, title: r.title, mode: r.mode,
      workflowId: r.workflow_id, assignee: r.assignee, status: r.status, dueDate: r.due,
      after: afterBy.get(r.item_id) ?? [], outputTemplate: r.output_template, outputOverride: r.output_path,
    })),
    workflows: wfs.rows.map((r) => ({
      id: r.workflow_id, name: r.name, engine: r.engine, trigger: r.trigger, maintainer: r.maintainer,
      command: r.command, description: r.description,
    })),
    runs: runs.rows.map(runFromRow),
  };
}

/** Progress shares per pipeline (complete) and per step (units past it), from the database. */
export async function progressFractions(db: Db): Promise<Record<string, number>> {
  const [counts, steps] = await Promise.all([
    db.query<{ pipeline_id: string; step_key: string | null; state: string; n: number }>(
      'SELECT pipeline_id, step_key, state, count(*)::int AS n FROM work_unit GROUP BY 1, 2, 3'),
    db.query<{ pipeline_id: string; step_key: string }>('SELECT pipeline_id, step_key FROM step ORDER BY pipeline_id, ordinal'),
  ]);
  const pipes = new Map<string, ProgressPipeline>();
  for (const r of steps.rows) {
    const p = pipes.get(r.pipeline_id) ?? { id: r.pipeline_id, expected: 0, released: 0, steps: [] };
    p.steps.push({ key: r.step_key, queued: 0, running: 0, failed: 0 });
    pipes.set(r.pipeline_id, p);
  }
  for (const r of counts.rows) {
    const p = pipes.get(r.pipeline_id);
    if (!p || r.state === 'excluded') continue;
    p.expected += r.n;
    if (r.state === 'released') p.released += r.n;
    else if (r.state === 'queued' || r.state === 'running' || r.state === 'failed') {
      const st = p.steps.find((x) => x.key === r.step_key);
      if (st) st[r.state] += r.n;
    }
  }
  return progressFromPipelines([...pipes.values()]);
}

/** Renders item output templates from the current path inventory. */
export async function outputRenderer(db: Db) {
  const [locs, studies] = await Promise.all([
    db.query<{ study_id: string; modality: ModalityKey | null; key: string; path: string }>(
      'SELECT study_id, modality, key, path FROM data_location'),
    db.query<{ study_id: string; release: string | null }>('SELECT study_id, release FROM study'),
  ]);
  const byStudy = new Map<string, { modality: ModalityKey | null; key: string; path: string }[]>();
  for (const l of locs.rows) byStudy.set(l.study_id, [...(byStudy.get(l.study_id) ?? []), l]);
  const release = new Map(studies.rows.map((r) => [r.study_id, r.release]));
  return (template: string, d: RawDeliverable) => renderPath(template, pathVars(byStudy.get(d.study ?? '') ?? [], {
    study: d.study ?? 'multi', release: d.release ?? release.get(d.study ?? '') ?? null, deliverable: d.id,
  }));
}

export async function currentPlan(db: Db) {
  const raw = await loadRawPlan(db);
  return computePlan(raw, await progressFractions(db), Date.now(), await outputRenderer(db));
}

async function findItem(db: Db, itemId: string) {
  const plan = await currentPlan(db);
  for (const d of plan.deliverables) {
    const it = d.items.find((i) => i.id === itemId);
    if (it) return { plan, deliverable: d, item: it };
  }
  throw new HttpError(404, `Unknown item "${itemId}"`);
}

// ---------- scheduler ----------

/**
 * Log deliverable state changes and (when `launch`) start every automated item that has become ready.
 * Called by the scheduler while it holds its lock.
 */
export async function reconcileDeliverables(db: Db, launch: boolean) {
  const plan = await currentPlan(db);
  const last = await db.query<{ deliverable_id: string; last_state: string | null }>(
    'SELECT deliverable_id, last_state FROM deliverable',
  );
  const prev = new Map(last.rows.map((r) => [r.deliverable_id, r.last_state]));
  for (const d of plan.deliverables) {
    const before = prev.get(d.id) ?? null;
    if (before === d.state) continue;
    await db.query('UPDATE deliverable SET last_state = $2 WHERE deliverable_id = $1', [d.id, d.state]);
    if (before === null) continue; // first sighting after a load
    let note: string | null = null;
    if (d.state === 'done') note = `“${d.title}” is done`;
    else if (before === 'blocked') note = `“${d.title}” is unblocked and ready to start`;
    else if (d.state === 'blocked') note = `“${d.title}” is blocked again: ${d.blockedBy[0] ?? ''}`;
    if (note) {
      await logEvent(db, {
        pipelineId: null, stepKey: null, unitIds: [], kind: 'deliverable', actor: 'scheduler',
        actorKind: 'system', note, deliverableId: d.id,
      });
    }
  }
  let started = 0;
  if (!launch) return { started };
  for (const it of itemsToTrigger(plan.deliverables, plan.workflows)) {
    await createRun(db, it.id, 'scheduler');
    started++;
  }
  return { started };
}

// ---------- runs ----------

async function createRun(db: Db, itemId: string, by: string) {
  const r = await db.query(
    `SELECT i.item_id, i.title, i.workflow_id, i.deliverable_id, w.name, w.engine
       FROM work_item i JOIN workflow w USING (workflow_id) WHERE i.item_id = $1`,
    [itemId],
  );
  if (!r.rowCount) throw new HttpError(404, `"${itemId}" is not an automated item`);
  const it = r.rows[0];
  let runId: number;
  try {
    const ins = await db.query<{ run_id: string }>(
      `INSERT INTO workflow_run (engine, workflow_id, item_id, triggered_by) VALUES ($1,$2,$3,$4) RETURNING run_id`,
      [it.engine, it.workflow_id, itemId, by],
    );
    runId = Number(ins.rows[0].run_id);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, `“${it.title}” already has a run in progress`);
    throw e;
  }
  await db.query(`UPDATE work_item SET status = 'in_progress', updated_at = now() WHERE item_id = $1`, [itemId]);
  await logEvent(db, {
    pipelineId: null, stepKey: null, unitIds: [], kind: 'run', actor: by,
    actorKind: by === 'scheduler' ? 'system' : 'person',
    note: `Queued ${it.name} for “${it.title}”`, deliverableId: it.deliverable_id, itemId, runId,
  });
  return runId;
}

/** Someone pressed Run (manual-trigger workflow) or Retry (after a failure). */
export async function triggerRun(db: Db, itemId: string, actor: string) {
  const { item } = await findItem(db, itemId);
  if (item.mode !== 'automated') throw new HttpError(400, `“${item.title}” is a manual item; mark it done instead`);
  if (item.status === 'blocked') throw new HttpError(409, `“${item.title}” can't run yet: ${item.blockedBy.join('; ')}`);
  if (item.status === 'done' || item.status === 'skipped') throw new HttpError(409, `“${item.title}” is already ${item.status}`);
  return createRun(db, itemId, actor);
}

// ---------- manual items ----------

export async function updateItem(db: Db, itemId: string, patch: ItemPatch, actor: string) {
  const { item } = await findItem(db, itemId);
  const wf = item.workflowId
    ? (await db.query<{ trigger: string }>('SELECT trigger FROM workflow WHERE workflow_id = $1', [item.workflowId])).rows[0]
    : null;
  // Manual items, and automated items whose script is run outside the tracker, are reported by people.
  const reportable = item.mode === 'manual' || wf?.trigger === 'external';
  if (patch.assignee !== undefined) {
    if (patch.assignee) {
      const p = await db.query('SELECT 1 FROM person WHERE name = $1', [patch.assignee]);
      if (!p.rowCount) throw new HttpError(400, `Unknown person "${patch.assignee}"`);
    }
    await db.query('UPDATE work_item SET assignee = $2, updated_at = now() WHERE item_id = $1', [itemId, patch.assignee]);
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'assign', actor, actorKind: 'person',
      deliverableId: item.deliverableId, itemId,
      note: patch.assignee === actor ? `${actor} took “${item.title}”`
        : patch.assignee ? `“${item.title}” assigned to ${patch.assignee}` : `“${item.title}” unassigned`,
    });
  }
  if (patch.outputPath !== undefined) {
    await db.query('UPDATE work_item SET output_path = $2, updated_at = now() WHERE item_id = $1', [itemId, patch.outputPath || null]);
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'item', actor, actorKind: 'person',
      deliverableId: item.deliverableId, itemId,
      note: patch.outputPath ? `Output of “${item.title}” recorded at ${patch.outputPath}` : `Output path of “${item.title}” reset to the template`,
    });
  }
  if (patch.status) {
    const to = patch.status;
    if (!['todo', 'in_progress', 'done', 'skipped', 'failed'].includes(to)) throw new HttpError(400, 'status must be todo, in_progress, done, failed or skipped');
    if (!reportable && to !== 'skipped') {
      throw new HttpError(400, `“${item.title}” is launched by the tracker; its status follows its workflow runs`);
    }
    if ((to === 'in_progress' || to === 'done') && item.status === 'blocked') {
      throw new HttpError(409, `“${item.title}” is blocked: ${item.blockedBy.join('; ')}`);
    }
    await db.query('UPDATE work_item SET status = $2, updated_at = now() WHERE item_id = $1', [itemId, to]);
    const verb = { todo: 'reopened', in_progress: 'started', done: 'completed', skipped: 'skipped', failed: 'reported a failure in' }[to];
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'item', actor, actorKind: 'person',
      deliverableId: item.deliverableId, itemId, note: `${actor} ${verb} “${item.title}”`,
    });
  }
}
