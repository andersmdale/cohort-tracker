// HTTP API + live updates over Server-Sent Events + the scheduler loop.
//
// Dashboard
//   GET   /api/snapshot                                  everything the dashboard shows
//   GET   /api/stream                                    SSE; emits "change" for every new event
// Pipelines
//   POST  /api/events                                    external engines report unit transitions
//   POST  /api/pipelines/:pipelineId/steps/:stepKey/retry
//   POST  /api/tasks                                     create a review batch by hand
//   PATCH /api/tasks/:id                                 assign / reassign / unassign a batch
//   POST  /api/tasks/:id/complete                        pass a batch
// Deliverables
//   PATCH /api/items/:id                                 assign a manual item or change its status
//   POST  /api/items/:id/run                             run (manual trigger) or retry an automated item
// Workers
//   POST  /api/workflow-runs/claim                       take the next queued run for your engines
//   GET   /api/workflow-runs/:id                         run details (command, sessions)
//   POST  /api/workflow-runs/:id/finish                  report success or failure
// Admin
//   POST  /api/scheduler/tick                            run one scheduler pass now
import express, { type NextFunction, type Request, type Response } from 'express';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DATABASE_URL, HttpError, pool, tx } from './db';
import { buildSnapshot } from './snapshot';
import {
  assignTask, completeTask, createTask, retryFailed, transition, type TransitionInput,
} from './services';
import { triggerRun, updateItem } from './plan';
import { claimRun, finishRun, getRun } from './runs';
import { reconcile } from './scheduler';
import type { ItemPatch } from '../../shared/types';

const PORT = Number(process.env.PORT ?? 4000);
const SCHEDULER_MS = Number(process.env.SCHEDULER_INTERVAL_MS ?? 3000);
const SCHEDULER_ON = (process.env.SCHEDULER ?? 'on') !== 'off';

const app = express();
app.use(express.json({ limit: '5mb' }));

type Handler = (req: Request, res: Response) => Promise<void>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" must be a non-empty string`);
  return v;
};
const actorOf = (body: Record<string, unknown>) => str(body?.actor, 'actor');

/** Run a write, then let the scheduler react right away instead of waiting for the next tick. */
async function write<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const out = await tx(fn);
  if (SCHEDULER_ON) await tx((c) => reconcile(c)).catch((e) => console.error('scheduler:', e.message));
  return out;
}

app.get('/api/health', h(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, scheduler: SCHEDULER_ON });
}));

app.get('/api/snapshot', h(async (req, res) => {
  const limit = Math.min(1000, Number(req.query.events ?? 200) || 200);
  res.json(await buildSnapshot(pool, limit));
}));

// ---------- SSE ----------
const clients = new Set<Response>();
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
setInterval(() => clients.forEach((c) => c.write(': ping\n\n')), 25_000).unref();

function broadcast(eventId: string) {
  const msg = `event: change\ndata: ${JSON.stringify({ eventId: Number(eventId) })}\n\n`;
  clients.forEach((c) => c.write(msg));
}

// One dedicated connection LISTENs, so changes made by any process (workers, engines) reach dashboards.
async function listen() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  client.on('notification', (m) => { if (m.payload) broadcast(m.payload); });
  client.on('error', (e) => {
    console.error('LISTEN connection lost:', e.message);
    client.end().catch(() => undefined);
    setTimeout(listen, 2000);
  });
  try {
    await client.connect();
    await client.query('LISTEN tracker');
  } catch (e) {
    console.error('Could not LISTEN on Postgres, retrying:', (e as Error).message);
    setTimeout(listen, 2000);
  }
}

// ---------- pipelines ----------
app.post('/api/events', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const input: TransitionInput = {
    pipelineId: str(b.pipeline_id, 'pipeline_id'),
    stepKey: str(b.step_key, 'step_key'),
    unitIds: Array.isArray(b.unit_ids) ? b.unit_ids.map(Number) : undefined,
    sessionIds: Array.isArray(b.session_ids) ? b.session_ids.map(String) : undefined,
    toState: str(b.to_state, 'to_state') as TransitionInput['toState'],
    actor: actorOf(b),
    actorKind: (b.actor_kind as TransitionInput['actorKind']) ?? 'pipeline',
    softwareVersion: typeof b.software_version === 'string' ? b.software_version : undefined,
    reasonCode: typeof b.reason_code === 'string' ? b.reason_code : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  };
  if (!input.unitIds?.length && !input.sessionIds?.length) throw new HttpError(400, 'Provide unit_ids or session_ids');
  res.json(await write((c) => transition(c, input)));
}));

app.post('/api/pipelines/:pipelineId/steps/:stepKey/retry', h(async (req, res) => {
  const n = await write((c) => retryFailed(c, req.params.pipelineId, req.params.stepKey, actorOf(req.body)));
  res.json({ requeued: n });
}));

app.post('/api/tasks', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const size = Number(b.size ?? 100);
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, '"size" must be a positive integer');
  const id = await write((c) => createTask(c, str(b.pipeline_id, 'pipeline_id'), str(b.step_key, 'step_key'),
    size, typeof b.assignee === 'string' ? b.assignee : null));
  if (id === null) throw new HttpError(409, 'No unbatched units are waiting at that step');
  res.status(201).json({ id });
}));

app.patch('/api/tasks/:id', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const assignee = b.assignee === null || b.assignee === '' ? null : str(b.assignee, 'assignee');
  await write((c) => assignTask(c, Number(req.params.id), assignee, actorOf(b)));
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/complete', h(async (req, res) => {
  res.json(await write((c) => completeTask(c, Number(req.params.id), actorOf(req.body))));
}));

// ---------- deliverables ----------
app.patch('/api/items/:id', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const patch: ItemPatch = {};
  if ('assignee' in b) patch.assignee = b.assignee === null || b.assignee === '' ? null : str(b.assignee, 'assignee');
  if ('status' in b) patch.status = str(b.status, 'status') as ItemPatch['status'];
  if (!('assignee' in patch) && !patch.status) throw new HttpError(400, 'Send assignee and/or status');
  await write((c) => updateItem(c, req.params.id, patch, actorOf(b)));
  res.json({ ok: true });
}));

app.post('/api/items/:id/run', h(async (req, res) => {
  const runId = await write((c) => triggerRun(c, req.params.id, actorOf(req.body)));
  res.status(201).json({ runId });
}));

// ---------- workers ----------
app.post('/api/workflow-runs/claim', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const engines = Array.isArray(b.engines) && b.engines.length ? b.engines.map(String) : null;
  const run = await tx((c) => claimRun(c, str(b.worker, 'worker'), engines));
  if (!run) { res.status(204).end(); return; }
  res.json(run);
}));

app.get('/api/workflow-runs/:id', h(async (req, res) => {
  res.json(await getRun(pool, Number(req.params.id)));
}));

app.post('/api/workflow-runs/:id/finish', h(async (req, res) => {
  const b = req.body as Record<string, unknown>;
  const status = str(b.status, 'status');
  if (status !== 'succeeded' && status !== 'failed') throw new HttpError(400, 'status must be succeeded or failed');
  res.json(await write((c) => finishRun(c, Number(req.params.id), {
    status, worker: str(b.worker, 'worker'),
    message: typeof b.message === 'string' ? b.message : null,
    failedUnitIds: Array.isArray(b.failed_unit_ids) ? b.failed_unit_ids.map(Number) : undefined,
    reasonCode: typeof b.reason_code === 'string' ? b.reason_code : null,
  })));
}));

app.post('/api/scheduler/tick', h(async (_req, res) => {
  res.json(await tx((c) => reconcile(c)));
}));

// Serve the built client when present, so production runs on one port.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'The server hit an unexpected error. Check the server log for details.' });
});

await listen();
if (SCHEDULER_ON) {
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tx((c) => reconcile(c))
      .catch((e) => console.error('scheduler:', e.message))
      .finally(() => { busy = false; });
  }, SCHEDULER_MS);
}
app.listen(PORT, () => {
  console.log(`Cohort tracker API on http://localhost:${PORT} (db: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}; scheduler ${SCHEDULER_ON ? `every ${SCHEDULER_MS} ms` : 'off'})`);
});
