// In-browser simulation with the same rules as the server: per-study config from studies.yaml,
// deliverables from plan.yaml, and a scheduler that launches work when dependencies are met.
// Used with `npm run dev:mock` and for demos where no server is running. Counts are at full config scale.
import YAML from 'yaml';
import studiesYaml from '../../../shared/studies.yaml?raw';
import planYaml from '../../../shared/plan.yaml?raw';
import { FAILURE_REASONS, mulberry32, seedDistribution } from '../../../shared/catalog';
import { candidatesFor, effectiveBatchSize, resolveConfig, type ConfigDoc, type ResolvedConfig } from '../../../shared/config';
import { computePlan, itemsToTrigger, normalizePlan, type PlanDoc, type RawPlan } from '../../../shared/plan';
import type {
  DeliverableState, EventKind, ItemPatch, PipelineStatus, Snapshot, Task, TrackerEvent, WorkflowRun,
} from '../../../shared/types';
import { BaseSource, type TrackerSource } from './source';

const rnd = (a: number, b: number) => Math.floor(a + Math.random() * (b - a + 1));
const pick = <T,>(xs: readonly T[]) => xs[rnd(0, xs.length - 1)];
const plural = (n: number) => `${n.toLocaleString('en-US')} unit${n === 1 ? '' : 's'}`;
const MAX_OPEN_REVIEW_BATCHES = 4;

export class MockSource extends BaseSource implements TrackerSource {
  readonly mode = 'mock' as const;
  private cfg: ResolvedConfig;
  private pipes: PipelineStatus[] = [];
  private tasks: Task[] = [];
  private events: TrackerEvent[] = [];
  private raw: RawPlan;
  private runTicks = new Map<number, number>();
  private lastState = new Map<string, DeliverableState>();
  private nextTask = 1;
  private nextEvent = 1;
  private nextRun = 1;
  private weighted: PipelineStatus[] = [];
  private excludeReason = new Map<string, string>();

  constructor(intervalMs = 1500) {
    super();
    this.cfg = resolveConfig(YAML.parse(studiesYaml) as ConfigDoc);
    const rand = mulberry32(20261101);
    for (const s of this.cfg.studies) {
      for (const rp of s.pipelines) {
        const d = seedDistribution(rp.steps, rp.units, s.sim, rand);
        const p: PipelineStatus = {
          id: rp.id, study: s.id, modality: rp.modality, kind: rp.kind, engine: rp.engine, version: rp.version,
          source: s.source, expected: rp.units, notReceived: d.notReceived, released: d.released, excluded: 0,
          settings: {
            batchSize: effectiveBatchSize(rp.scheduler, rp.units), maxActiveRuns: rp.scheduler.maxActiveRunsPerStep,
            autoRetry: rp.scheduler.autoRetry, qcBatchSize: rp.scheduler.qcBatchSize,
          },
          steps: rp.steps.map((st, i) => ({
            key: st.key, name: st.name, ordinal: i + 1, mode: st.mode, role: st.role, slaDays: st.slaDays,
            launch: st.launch, queued: d.steps[i].queued + d.steps[i].running, running: 0, failed: d.steps[i].failed,
            activeRuns: 0,
          })),
        };
        rp.steps.forEach((st) => st.excludeReason && this.excludeReason.set(`${p.id}|${st.key}`, st.excludeReason));
        this.pipes.push(p);
        for (let k = 0; k < s.sim.activity; k++) this.weighted.push(p);
        for (const st of rp.steps.filter((x) => x.mode === 'manual')) {
          const n = s.sim.activity >= 3 ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 2);
          const people = candidatesFor(this.cfg, s.id, st.role!);
          for (let b = 0; b < n; b++) {
            const r = rand();
            const assignee = r < 0.3 ? null : r < 0.45 ? 'You' : people[Math.floor(rand() * people.length)];
            this.addTask(p, st.key, Math.round(rp.scheduler.qcBatchSize * (0.4 + rand())), assignee, rand() * (st.slaDays ?? 7) * 1.8, false);
          }
        }
      }
    }
    const rows = normalizePlan(YAML.parse(planYaml) as PlanDoc, {
      people: this.cfg.people.map((p) => p.name),
      pipelines: this.pipes.map((p) => p.id),
      studies: this.cfg.studies.map((s) => s.id),
    });
    this.raw = { ...rows, runs: [] };
    for (const d of this.plan().deliverables) this.lastState.set(d.id, d.state);
    this.set({ status: 'live' });
    this.emit();
    window.setInterval(() => { if (!this.state.paused) { this.tick(); this.emit(); } }, intervalMs);
  }

  // ---------- helpers ----------

  private released() {
    return Object.fromEntries(this.pipes.map((p) => [p.id, p.expected ? p.released / p.expected : 0]));
  }

  private plan() {
    return computePlan(this.raw, this.released(), Date.now());
  }

  private emit() {
    const plan = this.plan();
    this.set({
      snapshot: {
        generatedAt: new Date().toISOString(),
        studies: this.cfg.studies.map((s) => ({ id: s.id, name: s.name, source: s.source, team: s.team })),
        people: this.cfg.people,
        pipelines: this.pipes.map((p) => ({ ...p, steps: p.steps.map((s) => ({ ...s })) })),
        tasks: [...this.tasks],
        events: this.events.slice(0, 200),
        deliverables: plan.deliverables,
        workflows: plan.workflows,
        runs: this.raw.runs.slice(0, 150),
      } satisfies Snapshot,
    });
  }

  private log(e: { pipeline?: PipelineStatus; deliverableId?: string; stepKey?: string | null; kind: EventKind; actor: string; n?: number; text: string }) {
    const d = e.deliverableId ? this.raw.deliverables.find((x) => x.id === e.deliverableId) : undefined;
    this.events.unshift({
      id: this.nextEvent++, at: new Date().toISOString(), pipelineId: e.pipeline?.id ?? null,
      deliverableId: e.deliverableId ?? null, study: e.pipeline?.study ?? d?.study ?? null,
      modality: e.pipeline?.modality ?? null, stepKey: e.stepKey ?? null, kind: e.kind, actor: e.actor,
      n: e.n ?? 0, text: e.text,
    });
    if (this.events.length > 400) this.events.pop();
  }

  private stepIdx(p: PipelineStatus, key: string) {
    const i = p.steps.findIndex((s) => s.key === key);
    if (i < 0) throw new Error(`Unknown step ${key}`);
    return i;
  }

  private advance(p: PipelineStatus, i: number, k: number) {
    if (i + 1 < p.steps.length) p.steps[i + 1].queued += k;
    else p.released += k;
  }

  private addTask(p: PipelineStatus, stepKey: string, size: number, assignee: string | null, ageDays: number, logIt: boolean) {
    const st = p.steps[this.stepIdx(p, stepKey)];
    const batched = this.tasks.filter((t) => t.pipelineId === p.id && t.stepKey === stepKey).reduce((a, t) => a + t.n, 0);
    const n = Math.min(Math.max(5, size), st.queued - batched);
    if (n <= 0) return false;
    const rp = this.cfg.studies.find((s) => s.id === p.study)!.pipelines.find((x) => x.id === p.id)!;
    const label = rp.steps.find((x) => x.key === stepKey)?.taskLabel ?? st.name;
    const created = Date.now() - ageDays * 864e5;
    const sla = st.slaDays ?? 7;
    const t: Task = {
      id: this.nextTask++, pipelineId: p.id, study: p.study, modality: p.modality, stepKey, stepName: st.name,
      label, role: st.role ?? 'qc_reviewer', slaDays: sla, n,
      createdAt: new Date(created).toISOString(), dueAt: new Date(created + sla * 864e5).toISOString(), assignee,
    };
    this.tasks.push(t);
    if (logIt) this.log({ pipeline: p, stepKey, kind: 'task', actor: 'tracker', n, text: `New ${label} batch of ${plural(n)}${assignee ? ` assigned to ${assignee}` : ' waiting for a reviewer'}` });
    return true;
  }

  private leastLoaded(study: string, role: Task['role']) {
    const pool = candidatesFor(this.cfg, study, role);
    const load = (name: string) => this.tasks.filter((t) => t.assignee === name).reduce((a, t) => a + t.n, 0);
    return [...pool].sort((a, b) => load(a) - load(b) || a.localeCompare(b))[0] ?? null;
  }

  // ---------- simulation + scheduler ----------

  private tick() {
    const p = pick(this.weighted);
    const base = Math.max(1, Math.round(p.expected / 2500));
    // sources
    if (Math.random() < 0.2 && p.notReceived > 0) {
      const k = Math.min(p.notReceived, base * rnd(2, 10));
      p.notReceived -= k;
      p.steps[0].queued += k;
      this.log({ pipeline: p, stepKey: p.steps[0].key, kind: 'arrive', actor: p.source, n: k, text: `${plural(k)} received, queued for ${p.steps[0].name}` });
    }
    // processing at automated steps (scheduler-launched runs or external engines)
    const cand = p.steps.map((_, i) => i).filter((i) => p.steps[i].mode === 'auto' && p.steps[i].queued + p.steps[i].running > 0);
    if (cand.length) {
      const i = pick(cand);
      const s = p.steps[i];
      const actor = s.launch === 'external' ? `${p.engine}@${p.version}` : 'sim-worker';
      if (s.running > 0 && Math.random() < 0.6) {
        const k = s.running;
        const f = Math.random() < 0.15 ? Math.max(1, Math.round(k * 0.12)) : 0;
        s.running = 0;
        s.failed += f;
        this.advance(p, i, k - f);
        if (k - f) this.log({ pipeline: p, stepKey: s.key, kind: 'done', actor, n: k - f, text: `${s.name}: ${plural(k - f)} completed` });
        if (f) this.log({ pipeline: p, stepKey: s.key, kind: 'fail', actor, n: f, text: `${s.name}: ${plural(f)} failed (${pick(FAILURE_REASONS)})` });
      } else if (s.queued > 0) {
        const slots = s.launch === 'scheduler' ? p.settings.maxActiveRuns : 2;
        const k = Math.min(s.queued, p.settings.batchSize * slots, base * rnd(1, 8));
        s.queued -= k;
        s.running += k;
        this.log({ pipeline: p, stepKey: s.key, kind: 'start', actor, n: k, text: `${s.name}: started ${plural(k)}` });
      }
    }
    for (const pp of this.pipes) {
      for (const s of pp.steps) {
        s.activeRuns = s.launch === 'scheduler' && s.running > 0 ? Math.min(pp.settings.maxActiveRuns, Math.ceil(s.running / pp.settings.batchSize)) : 0;
      }
    }
    // automatic retries
    if (Math.random() < 0.3) {
      const pp = pick(this.pipes.filter((x) => x.settings.autoRetry > 0));
      const s = pp?.steps.find((x) => x.failed > 0);
      if (pp && s) {
        const k = Math.ceil(s.failed / 2);
        s.failed -= k;
        s.queued += k;
        this.log({ pipeline: pp, stepKey: s.key, kind: 'retry', actor: 'scheduler', n: k, text: `${s.name}: ${plural(k)} retried automatically` });
      }
    }
    // review batches, auto-assigned within the study team
    for (const pp of this.pipes) {
      for (const s of pp.steps.filter((x) => x.mode === 'manual')) {
        const open = this.tasks.filter((t) => t.pipelineId === pp.id && t.stepKey === s.key);
        const unbatched = s.queued - open.reduce((a, t) => a + t.n, 0);
        if (open.length >= MAX_OPEN_REVIEW_BATCHES || unbatched <= 0) continue;
        if (unbatched < pp.settings.qcBatchSize && open.length > 0) continue;
        this.addTask(pp, s.key, pp.settings.qcBatchSize, this.leastLoaded(pp.study, s.role ?? 'qc_reviewer'), 0, true);
      }
    }
    // colleagues
    if (Math.random() < 0.1) {
      const others = this.tasks.filter((t) => t.assignee && t.assignee !== 'You');
      if (others.length) { const t = pick(others); this.complete(t, t.assignee!); }
    }
    this.deliverables();
  }

  private deliverables() {
    // finish / start runs (the worker)
    for (const r of this.raw.runs) {
      if (r.status !== 'queued' && r.status !== 'running') continue;
      const left = (this.runTicks.get(r.id) ?? 0) - 1;
      this.runTicks.set(r.id, left);
      const it = this.raw.items.find((i) => i.id === r.itemId)!;
      const wf = this.raw.workflows.find((w) => w.id === r.workflowId)!;
      if (r.status === 'queued') {
        r.status = 'running'; r.startedAt = new Date().toISOString(); r.worker = 'sim-worker';
        this.log({ deliverableId: it.deliverableId, kind: 'run', actor: 'sim-worker', text: `${wf.name} started for “${it.title}”` });
      } else if (left <= 0) {
        const ok = Math.random() < 0.85;
        r.status = ok ? 'succeeded' : 'failed'; r.finishedAt = new Date().toISOString();
        r.message = ok ? null : pick(['out of memory on node c-114', 'input checksum mismatch', 'wall time exceeded']);
        it.status = ok ? 'done' : 'failed';
        this.log({ deliverableId: it.deliverableId, kind: 'run', actor: 'sim-worker', text: `${wf.name} ${r.status} for “${it.title}”${r.message ? `: ${r.message}` : ''}` });
      }
    }
    // colleagues work their deliverable items
    let plan = this.plan();
    if (Math.random() < 0.08) {
      const items = plan.deliverables.flatMap((d) => d.items).filter((i) =>
        i.mode === 'manual' && i.assignee && i.assignee !== 'You' && (i.status === 'ready' || i.status === 'in_progress'));
      if (items.length) {
        const it = pick(items);
        this.setItemStatus(it.id, it.status === 'ready' ? 'in_progress' : 'done', it.assignee!);
        plan = this.plan();
      }
    }
    // the scheduler: log state changes, then launch ready automated items
    for (const d of plan.deliverables) {
      const before = this.lastState.get(d.id);
      if (before === d.state) continue;
      this.lastState.set(d.id, d.state);
      const text = d.state === 'done' ? `“${d.title}” is done`
        : before === 'blocked' ? `“${d.title}” is unblocked and ready to start`
        : d.state === 'blocked' ? `“${d.title}” is blocked again: ${d.blockedBy[0] ?? ''}` : null;
      if (text) this.log({ deliverableId: d.id, kind: 'deliverable', actor: 'scheduler', text });
    }
    for (const it of itemsToTrigger(plan.deliverables, plan.workflows)) this.queueRun(it.id, 'scheduler');
  }

  private queueRun(itemId: string, by: string) {
    const it = this.raw.items.find((i) => i.id === itemId)!;
    const wf = this.raw.workflows.find((w) => w.id === it.workflowId)!;
    const run: WorkflowRun = {
      id: this.nextRun++, engine: wf.engine, workflowId: wf.id, itemId, pipelineId: null, stepKey: null, n: 0,
      status: 'queued', triggeredBy: by, worker: null, message: null,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
    this.raw.runs.unshift(run);
    this.runTicks.set(run.id, rnd(4, 12));
    it.status = 'in_progress';
    this.log({ deliverableId: it.deliverableId, kind: 'run', actor: by, text: `Queued ${wf.name} for “${it.title}”` });
  }

  private setItemStatus(itemId: string, status: NonNullable<ItemPatch['status']>, actor: string) {
    const it = this.raw.items.find((i) => i.id === itemId)!;
    it.status = status;
    const verb = { todo: 'reopened', in_progress: 'started', done: 'completed', skipped: 'skipped' }[status];
    this.log({ deliverableId: it.deliverableId, kind: 'item', actor, text: `${actor} ${verb} “${it.title}”` });
  }

  private complete(t: Task, actor: string) {
    const p = this.pipes.find((x) => x.id === t.pipelineId)!;
    const i = this.stepIdx(p, t.stepKey);
    const s = p.steps[i];
    const k = Math.min(t.n, s.queued);
    const ex = Math.round(k * 0.03);
    s.queued -= k;
    this.advance(p, i, k - ex);
    p.excluded += ex;
    p.expected -= ex;
    this.tasks = this.tasks.filter((x) => x.id !== t.id);
    if (ex) this.log({ pipeline: p, stepKey: s.key, kind: 'decision', actor, n: ex, text: `${s.name}: ${plural(ex)} excluded (${this.excludeReason.get(`${p.id}|${s.key}`) ?? 'no reason code'})` });
    this.log({ pipeline: p, stepKey: s.key, kind: 'decision', actor, n: k - ex, text: `${s.name}: ${plural(k - ex)} passed (batch #${t.id})` });
  }

  // ---------- actions ----------

  setPaused = (paused: boolean) => this.set({ paused });

  retryFailed = async (pipelineId: string, stepKey: string, actor: string) => {
    const p = this.pipes.find((x) => x.id === pipelineId)!;
    const s = p.steps[this.stepIdx(p, stepKey)];
    const k = s.failed;
    if (!k) return;
    s.failed = 0;
    s.queued += k;
    this.log({ pipeline: p, stepKey, kind: 'retry', actor, n: k, text: `${s.name}: ${plural(k)} requeued after failure` });
    this.emit();
  };

  assignTask = async (taskId: number, assignee: string | null, actor: string) => {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`Batch ${taskId} is already closed`);
    t.assignee = assignee;
    const p = this.pipes.find((x) => x.id === t.pipelineId)!;
    this.log({ pipeline: p, stepKey: t.stepKey, kind: 'assign', actor, n: t.n,
      text: assignee === actor ? `${actor} claimed ${t.label} batch #${t.id}`
        : assignee ? `${t.label} batch #${t.id} assigned to ${assignee}` : `${t.label} batch #${t.id} returned to the pool` });
    this.tasks = [...this.tasks];
    this.emit();
  };

  completeTask = async (taskId: number, actor: string) => {
    const t = this.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`Batch ${taskId} is already closed`);
    this.complete(t, actor);
    this.emit();
  };

  updateItem = async (itemId: string, patch: ItemPatch, actor: string) => {
    const item = this.plan().deliverables.flatMap((d) => d.items).find((i) => i.id === itemId);
    if (!item) throw new Error(`Unknown item "${itemId}"`);
    const raw = this.raw.items.find((i) => i.id === itemId)!;
    if (patch.assignee !== undefined) {
      if (item.mode !== 'manual') throw new Error(`“${item.title}” is automated; its workflow maintainer is responsible`);
      raw.assignee = patch.assignee;
      this.log({ deliverableId: raw.deliverableId, kind: 'assign', actor,
        text: patch.assignee === actor ? `${actor} took “${item.title}”` : patch.assignee ? `“${item.title}” assigned to ${patch.assignee}` : `“${item.title}” unassigned` });
    }
    if (patch.status) {
      if (item.mode !== 'manual') throw new Error(`“${item.title}” is automated; its status follows its workflow runs`);
      if ((patch.status === 'in_progress' || patch.status === 'done') && item.status === 'blocked') {
        throw new Error(`“${item.title}” is blocked: ${item.blockedBy.join('; ')}`);
      }
      this.setItemStatus(itemId, patch.status, actor);
    }
    this.deliverables();
    this.emit();
  };

  runItem = async (itemId: string, actor: string) => {
    const item = this.plan().deliverables.flatMap((d) => d.items).find((i) => i.id === itemId);
    if (!item) throw new Error(`Unknown item "${itemId}"`);
    if (item.mode !== 'automated') throw new Error(`“${item.title}” is a manual item; mark it done instead`);
    if (item.status === 'blocked') throw new Error(`“${item.title}” can't run yet: ${item.blockedBy.join('; ')}`);
    if (item.lastRun && (item.lastRun.status === 'queued' || item.lastRun.status === 'running')) {
      throw new Error(`“${item.title}” already has a run in progress`);
    }
    this.queueRun(itemId, actor);
    this.emit();
  };
}
