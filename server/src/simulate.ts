// Simulates everything outside the tracker so the dashboard has something to show:
//   - source adapters delivering new units
//   - external engines (steps with launch: external) reporting progress
//   - a worker that claims scheduler-launched runs and finishes them after a while
//   - colleagues passing their review batches and working their deliverable items
// The scheduler in the API server does the launching; this script never starts processing itself.
//   npm run simulate
//   npm run simulate -- --interval 500 --capacity 40
import { pool, tx } from './db';
import { FAILURE_REASONS } from '../../shared/catalog';
import { completeTask, finishStep, getPipeline, receive, startStep } from './services';
import { currentPlan, updateItem } from './plan';
import { claimRun, finishRun, type ClaimedRun } from './runs';
import { readConfig } from './config';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const interval = Number(arg('--interval', '1000'));
const capacity = Number(arg('--capacity', '30'));
const rnd = (a: number, b: number) => Math.floor(a + Math.random() * (b - a + 1));
const pick = <T,>(xs: T[]) => xs[rnd(0, xs.length - 1)];
const WORKER = 'sim-worker';

const cfg = readConfig();
const activity = Object.fromEntries(cfg.studies.map((s) => [s.id, s.sim.activity]));
const running = new Map<number, { run: ClaimedRun; doneAt: number }>();

interface Pipe { id: string; study: string; units: number }

async function sources(p: Pipe) {
  const base = Math.max(1, Math.round(p.units / 400));
  await tx((c) => receive(c, p.id, base * rnd(2, 10)));
}

async function externalEngines(p: Pipe) {
  const ext = await pool.query<{ step_key: string; queued: number; running: number }>(
    `SELECT s.step_key,
            count(w.unit_id) FILTER (WHERE w.state = 'queued')::int AS queued,
            count(w.unit_id) FILTER (WHERE w.state = 'running')::int AS running
       FROM step s LEFT JOIN work_unit w ON w.pipeline_id = s.pipeline_id AND w.step_key = s.step_key
      WHERE s.pipeline_id = $1 AND s.mode = 'auto' AND s.launch = 'external'
      GROUP BY s.step_key HAVING count(w.unit_id) FILTER (WHERE w.state IN ('queued','running')) > 0`, [p.id]);
  if (!ext.rowCount) return;
  const s = pick(ext.rows);
  const base = Math.max(1, Math.round(p.units / 400));
  await tx(async (c) => {
    if (s.running > 0 && Math.random() < 0.6) {
      await finishStep(c, p.id, s.step_key, base * rnd(1, 6), Math.random() < 0.15 ? 0.12 : 0, pick([...FAILURE_REASONS]));
    } else {
      await startStep(c, p.id, s.step_key, base * rnd(1, 8));
    }
  });
}

async function worker() {
  const now = Date.now();
  for (const [id, r] of running) {
    if (r.doneAt > now) continue;
    running.delete(id);
    if (r.run.kind === 'processing') {
      const ids = r.run.unitIds ?? [];
      const failed = Math.random() < 0.2 ? ids.filter(() => Math.random() < 0.15) : [];
      await tx((c) => finishRun(c, id, {
        status: 'succeeded', worker: WORKER, failedUnitIds: failed,
        reasonCode: failed.length ? pick([...FAILURE_REASONS]) : null,
      }));
    } else {
      const ok = Math.random() < 0.85;
      await tx((c) => finishRun(c, id, {
        status: ok ? 'succeeded' : 'failed', worker: WORKER,
        message: ok ? null : pick(['out of memory on node c-114', 'input checksum mismatch', 'wall time exceeded']),
      }));
    }
  }
  while (running.size < capacity) {
    const run = await tx((c) => claimRun(c, WORKER, null));
    if (!run) break;
    const seconds = run.kind === 'processing' ? rnd(2, 8) : rnd(6, 20);
    running.set(run.runId, { run, doneAt: now + seconds * 1000 });
  }
}

async function colleagues() {
  if (Math.random() < 0.1) {
    const t = await pool.query<{ task_id: string; assignee: string }>(
      `SELECT task_id, assignee FROM task WHERE status = 'open' AND assignee IS NOT NULL AND assignee <> 'You'
        ORDER BY random() LIMIT 1`);
    if (t.rowCount) await tx((c) => completeTask(c, Number(t.rows[0].task_id), t.rows[0].assignee));
  }
  if (Math.random() < 0.06) {
    const plan = await currentPlan(pool);
    const items = plan.deliverables.flatMap((d) => d.items).filter((i) =>
      i.mode === 'manual' && i.assignee && i.assignee !== 'You' && (i.status === 'ready' || i.status === 'in_progress'));
    if (items.length) {
      const it = pick(items);
      await tx((c) => updateItem(c, it.id, { status: it.status === 'ready' ? 'in_progress' : 'done' }, it.assignee!));
    }
  }
}

async function main() {
  const r = await pool.query<{ pipeline_id: string; study_id: string; units: number }>(
    `SELECT p.pipeline_id, p.study_id, count(w.unit_id)::int AS units
       FROM pipeline p JOIN work_unit w USING (pipeline_id) GROUP BY 1, 2`);
  if (!r.rowCount) throw new Error('No pipelines found. Run "npm run db:reset" first.');
  const weighted: Pipe[] = r.rows.flatMap((x) =>
    Array<Pipe>(activity[x.study_id] ?? 1).fill({ id: x.pipeline_id, study: x.study_id, units: x.units }));
  await getPipeline(pool, weighted[0].id);
  console.log(`Simulating sources, external engines, a worker (capacity ${capacity}) and colleagues every ${interval} ms. Ctrl-C to stop.`);
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    (async () => {
      const p = pick(weighted);
      if (Math.random() < 0.25) await sources(p);
      await externalEngines(pick(weighted));
      await worker();
      await colleagues();
    })().catch((e) => console.error('tick failed:', e.message)).finally(() => { busy = false; });
  }, interval);
}

main().catch(async (e) => { console.error(e.message); await pool.end(); process.exit(1); });
