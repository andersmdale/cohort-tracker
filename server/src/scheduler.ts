// The scheduler launches work as soon as its dependencies are met:
//   1. failed units with retries left go back in the queue (per-study auto_retry)
//   2. units waiting at an automated step are batched into processing runs for workers
//      (per-study batch_size and max_active_runs_per_step; steps with launch: external are left alone)
//   3. units waiting at a manual step are batched into review tasks and assigned to the
//      least-loaded member of the study's team with the right role (per-study qc_batch_size)
//   4. deliverables whose dependencies and gates are now met have their automated items started
// It runs every few seconds in the API server. An advisory lock makes it safe if several servers run.
import type pg from 'pg';
import { logEvent, createTask } from './services';
import { reconcileDeliverables } from './plan';

/** Don't pile more open review batches than this onto one step; the rest wait until reviewers catch up. */
const MAX_OPEN_REVIEW_BATCHES = Number(process.env.MAX_OPEN_REVIEW_BATCHES ?? 4);

const plural = (n: number) => `${n.toLocaleString('en-US')} unit${n === 1 ? '' : 's'}`;

async function autoRetry(db: pg.PoolClient) {
  const r = await db.query<{ pipeline_id: string; step_key: string; name: string; ids: string[] }>(
    `WITH requeued AS (
       UPDATE work_unit w SET state = 'queued', updated_at = now()
         FROM pipeline p
        WHERE w.pipeline_id = p.pipeline_id AND w.state = 'failed' AND w.attempts <= p.auto_retry
       RETURNING w.unit_id, w.pipeline_id, w.step_key)
     SELECT q.pipeline_id, q.step_key, s.name, array_agg(q.unit_id) AS ids
       FROM requeued q JOIN step s USING (pipeline_id, step_key) GROUP BY 1, 2, 3`,
  );
  for (const x of r.rows) {
    await logEvent(db, {
      pipelineId: x.pipeline_id, stepKey: x.step_key, unitIds: x.ids.map(Number), fromState: 'failed', toState: 'queued',
      kind: 'retry', actor: 'scheduler', actorKind: 'system',
      note: `${x.name}: ${plural(x.ids.length)} retried automatically`,
    });
  }
  return r.rows.reduce((a, x) => a + x.ids.length, 0);
}

async function launchProcessing(db: pg.PoolClient) {
  // Steps with unbatched queued units and spare run capacity
  const r = await db.query<{
    pipeline_id: string; step_key: string; engine: string; batch_size: number; slots: number;
  }>(
    `WITH active AS (
       SELECT pipeline_id, step_key, count(*)::int AS n FROM workflow_run
        WHERE status IN ('queued','running') AND pipeline_id IS NOT NULL GROUP BY 1, 2),
     reserved AS (
       SELECT unnest(unit_ids) AS unit_id FROM workflow_run WHERE status = 'queued' AND pipeline_id IS NOT NULL)
     SELECT w.pipeline_id, w.step_key, p.engine, p.batch_size,
            (p.max_active_runs - COALESCE(a.n, 0))::int AS slots
       FROM work_unit w
       JOIN step s USING (pipeline_id, step_key)
       JOIN pipeline p USING (pipeline_id)
       LEFT JOIN active a USING (pipeline_id, step_key)
      WHERE w.state = 'queued' AND s.mode = 'auto' AND s.launch = 'scheduler'
        AND p.max_active_runs > COALESCE(a.n, 0)
        AND NOT EXISTS (SELECT 1 FROM reserved r WHERE r.unit_id = w.unit_id)
      GROUP BY 1, 2, 3, 4, 5`,
  );
  let runs = 0;
  for (const x of r.rows) {
    for (let i = 0; i < x.slots; i++) {
      const ins = await db.query(
        `INSERT INTO workflow_run (engine, pipeline_id, step_key, unit_ids, triggered_by)
         SELECT $3, $1, $2, array_agg(unit_id), 'scheduler' FROM (
           SELECT w.unit_id FROM work_unit w
            WHERE w.pipeline_id = $1 AND w.step_key = $2 AND w.state = 'queued'
              AND NOT EXISTS (SELECT 1 FROM workflow_run r
                               WHERE r.status = 'queued' AND r.pipeline_id = $1 AND r.step_key = $2
                                 AND r.unit_ids @> ARRAY[w.unit_id])
            ORDER BY w.unit_id LIMIT $4) b
         HAVING count(*) > 0
         RETURNING run_id`,
        [x.pipeline_id, x.step_key, x.engine, x.batch_size],
      );
      if (!ins.rowCount) break;
      runs++;
    }
  }
  return runs;
}

async function batchReviews(db: pg.PoolClient) {
  // Manual steps with queued units that are not in an open batch yet
  const r = await db.query<{
    pipeline_id: string; step_key: string; study_id: string; role: string; qc_batch_size: number;
    unbatched: number; open_tasks: number;
  }>(
    `SELECT w.pipeline_id, w.step_key, p.study_id, s.role, p.qc_batch_size, count(*)::int AS unbatched,
            (SELECT count(*)::int FROM task t WHERE t.status = 'open' AND t.pipeline_id = w.pipeline_id AND t.step_key = w.step_key) AS open_tasks
       FROM work_unit w
       JOIN step s USING (pipeline_id, step_key)
       JOIN pipeline p USING (pipeline_id)
      WHERE w.state = 'queued' AND s.mode = 'manual'
        AND NOT EXISTS (SELECT 1 FROM task t WHERE t.status = 'open' AND t.unit_ids @> ARRAY[w.unit_id])
      GROUP BY 1, 2, 3, 4, 5`,
  );
  let created = 0;
  for (const x of r.rows) {
    // Full batches always; a partial batch only when nothing else is open for that step
    const full = x.unbatched >= x.qc_batch_size;
    if (!full && x.open_tasks > 0) continue;
    if (x.open_tasks >= MAX_OPEN_REVIEW_BATCHES) continue;
    // Least-loaded team member with the role; fall back to anyone with the role
    const who = await db.query<{ name: string }>(
      `WITH pool AS (
         SELECT person AS name FROM study_team WHERE study_id = $1 AND role = $2
         UNION SELECT name FROM person WHERE role = $2 AND NOT EXISTS (SELECT 1 FROM study_team WHERE study_id = $1 AND role = $2))
       SELECT pool.name, COALESCE(sum(cardinality(t.unit_ids)), 0) AS load
         FROM pool LEFT JOIN task t ON t.assignee = pool.name AND t.status = 'open'
        GROUP BY 1 ORDER BY load, name LIMIT 1`,
      [x.study_id, x.role],
    );
    const id = await createTask(db, x.pipeline_id, x.step_key, x.qc_batch_size, who.rows[0]?.name ?? null);
    if (id !== null) created++;
  }
  return created;
}

export interface TickResult { retried: number; runs: number; reviews: number; deliverableRuns: number }

/** One scheduler pass. With launch=false it only records deliverable states (used after seeding). */
export async function reconcile(db: pg.PoolClient, opts: { launch?: boolean } = {}): Promise<TickResult | null> {
  const launch = opts.launch ?? true;
  const lock = await db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock(424242) AS ok');
  if (!lock.rows[0].ok) return null;
  const out: TickResult = { retried: 0, runs: 0, reviews: 0, deliverableRuns: 0 };
  if (launch) {
    out.retried = await autoRetry(db);
    out.runs = await launchProcessing(db);
    out.reviews = await batchReviews(db);
  }
  out.deliverableRuns = (await reconcileDeliverables(db, launch)).started;
  return out;
}
