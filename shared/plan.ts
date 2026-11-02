// Deliverable planning logic shared by the server (scheduler, snapshot) and the client (mock mode).
// Pure functions: no I/O, no YAML parsing (callers parse plan.yaml and pass the object in).
import type {
  Deliverable, DeliverableKind, DeliverableState, Gate, ItemMode, ItemStatus, ItemStoredStatus, Raci, Risk,
  Workflow, WorkflowRun, WorkflowTrigger, WorkItem,
} from './types';

// ---------- plan file shape (plan.yaml) ----------

export interface WorkflowDef {
  id: string; name: string; engine: string; trigger: WorkflowTrigger; maintainer: string;
  command: string; description?: string;
}
export interface ItemDef {
  id: string; title: string; mode: ItemMode; workflow?: string;
  /** Who does it (manual) or who runs it (automated). */
  assignee?: string;
  status?: ItemStoredStatus; due?: string; after?: string[];
  /** Where the result goes: path template using the study's path inventory plus {release} {deliverable}. */
  output?: string;
}
export interface DeliverableDef {
  id: string; title: string; study?: string | null; kind: DeliverableKind; owner: string; due?: string;
  release?: string;
  description?: string; depends_on?: string[];
  /** `done` (or legacy `released`) = share of units past `step`, or complete when step is omitted. */
  gates?: { pipeline: string; step?: string; done?: number; released?: number }[];
  raci?: Partial<Record<Raci, string[]>>; items: ItemDef[];
}
export interface PlanDoc { workflows: WorkflowDef[]; deliverables: DeliverableDef[] }

// ---------- normalized rows (what the database stores) ----------

export interface RawDeliverable {
  id: string; title: string; study: string | null; kind: DeliverableKind; description: string | null;
  owner: string; dueDate: string | null; dependsOn: string[]; release: string | null;
  gates: { pipelineId: string; stepKey: string | null; threshold: number }[]; raci: { person: string; role: Raci }[]; sortOrder: number;
}
export interface RawItem {
  id: string; deliverableId: string; ordinal: number; title: string; mode: ItemMode;
  workflowId: string | null; assignee: string | null; status: ItemStoredStatus; dueDate: string | null; after: string[];
  outputTemplate: string | null;
  /** Actual output path recorded by whoever ran it, when it differs from the template. */
  outputOverride?: string | null;
}
export interface RawWorkflow {
  id: string; name: string; engine: string; trigger: WorkflowTrigger; maintainer: string;
  command: string; description: string | null;
}
export interface RawPlan {
  deliverables: RawDeliverable[];
  items: RawItem[];
  workflows: RawWorkflow[];
  /** Recent runs, newest first. */
  runs: WorkflowRun[];
}

const KINDS: DeliverableKind[] = ['data_release', 'derivative', 'analysis', 'report', 'infrastructure'];
const STORED: ItemStoredStatus[] = ['todo', 'in_progress', 'done', 'failed', 'skipped'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns one cycle (as a list of ids) if the graph has any. */
export function findCycle(edges: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1 = on stack, 2 = done
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of edges.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/**
 * Check a parsed plan file and turn it into rows. Throws with every problem listed
 * (unknown people, pipelines, workflows, dependencies, or cycles).
 */
export function normalizePlan(
  doc: PlanDoc, known: { people: string[]; pipelines: string[]; studies: string[]; steps?: Record<string, string[]> },
): Omit<RawPlan, 'runs'> {
  const errors: string[] = [];
  const people = new Set(known.people);
  const pipelines = new Set(known.pipelines);
  const studies = new Set(known.studies);
  const person = (who: string | undefined, where: string) => {
    if (who && !people.has(who)) errors.push(`${where}: unknown person "${who}"`);
  };

  const workflows: RawWorkflow[] = [];
  const wfIds = new Set<string>();
  for (const w of doc.workflows ?? []) {
    const where = `workflow ${w.id ?? '(no id)'}`;
    if (!w.id || !w.name || !w.command) errors.push(`${where}: id, name and command are required`);
    if (wfIds.has(w.id)) errors.push(`${where}: duplicate id`);
    if (!['on_ready', 'manual', 'external'].includes(w.trigger)) errors.push(`${where}: trigger must be external, on_ready or manual`);
    person(w.maintainer, where);
    wfIds.add(w.id);
    workflows.push({
      id: w.id, name: w.name, engine: w.engine ?? 'script', trigger: w.trigger, maintainer: w.maintainer,
      command: w.command, description: w.description ?? null,
    });
  }

  const deliverables: RawDeliverable[] = [];
  const items: RawItem[] = [];
  const dIds = new Set((doc.deliverables ?? []).map((d) => d.id));
  const seen = new Set<string>();
  (doc.deliverables ?? []).forEach((d, order) => {
    const where = `deliverable ${d.id ?? '(no id)'}`;
    if (!d.id || !d.title) errors.push(`${where}: id and title are required`);
    if (seen.has(d.id)) errors.push(`${where}: duplicate id`);
    seen.add(d.id);
    if (!KINDS.includes(d.kind)) errors.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (d.study && !studies.has(d.study)) errors.push(`${where}: unknown study "${d.study}"`);
    if (d.due && !DATE.test(String(d.due))) errors.push(`${where}: due must be YYYY-MM-DD`);
    if (!d.owner) errors.push(`${where}: owner is required`);
    person(d.owner, where);
    for (const dep of d.depends_on ?? []) {
      if (!dIds.has(dep)) errors.push(`${where}: depends on unknown deliverable "${dep}"`);
      if (dep === d.id) errors.push(`${where}: depends on itself`);
    }
    for (const g of d.gates ?? []) {
      const share = g.done ?? g.released;
      if (!pipelines.has(g.pipeline)) errors.push(`${where}: unknown pipeline "${g.pipeline}"`);
      else if (g.step && known.steps && !known.steps[g.pipeline]?.includes(g.step)) errors.push(`${where}: pipeline ${g.pipeline} has no step "${g.step}"`);
      if (!(share !== undefined && share > 0 && share <= 1)) errors.push(`${where}: gate ${g.pipeline} needs done between 0 and 1`);
    }
    const raci: { person: string; role: Raci }[] = [{ person: d.owner, role: 'A' }];
    for (const [role, names] of Object.entries(d.raci ?? {}) as [Raci, string[]][]) {
      if (!['R', 'A', 'C', 'I'].includes(role)) { errors.push(`${where}: RACI role must be R, A, C or I`); continue; }
      for (const n of names ?? []) {
        person(n, `${where} RACI`);
        if (!raci.some((r) => r.person === n && r.role === role)) raci.push({ person: n, role });
      }
    }
    if (raci.filter((r) => r.role === 'A').length > 1) errors.push(`${where}: only the owner can be Accountable`);
    deliverables.push({
      id: d.id, title: d.title, study: d.study ?? null, kind: d.kind, description: d.description ?? null,
      owner: d.owner, dueDate: d.due ? String(d.due) : null, dependsOn: d.depends_on ?? [],
      release: d.release != null ? String(d.release) : null,
      gates: (d.gates ?? []).map((g) => ({ pipelineId: g.pipeline, stepKey: g.step ?? null, threshold: (g.done ?? g.released)! })),
      raci, sortOrder: order,
    });

    const local = new Set((d.items ?? []).map((i) => i.id));
    if (!(d.items ?? []).length) errors.push(`${where}: needs at least one item`);
    (d.items ?? []).forEach((it, i) => {
      const iw = `${where} item ${it.id ?? i + 1}`;
      if (!it.id || !it.title) errors.push(`${iw}: id and title are required`);
      if (it.mode === 'automated') {
        if (!it.workflow || !wfIds.has(it.workflow)) errors.push(`${iw}: automated items need a known workflow`);
      } else if (it.mode === 'manual') {
        if (it.workflow) errors.push(`${iw}: manual items cannot have a workflow`);
      } else errors.push(`${iw}: mode must be manual or automated`);
      person(it.assignee, iw);
      if (it.status && !STORED.includes(it.status)) errors.push(`${iw}: status must be one of ${STORED.join(', ')}`);
      if (it.due && !DATE.test(String(it.due))) errors.push(`${iw}: due must be YYYY-MM-DD`);
      for (const a of it.after ?? []) if (!local.has(a)) errors.push(`${iw}: "after" refers to unknown item "${a}"`);
      items.push({
        id: `${d.id}/${it.id}`, deliverableId: d.id, ordinal: i + 1, title: it.title, mode: it.mode,
        workflowId: it.mode === 'automated' ? it.workflow ?? null : null,
        assignee: it.assignee ?? null,
        status: it.status ?? 'todo', dueDate: it.due ? String(it.due) : null,
        after: (it.after ?? []).map((a) => `${d.id}/${a}`),
        outputTemplate: it.output ?? null,
      });
    });
  });

  const dCycle = findCycle(new Map(deliverables.map((d) => [d.id, d.dependsOn])));
  if (dCycle) errors.push(`deliverable dependency cycle: ${dCycle.join(' → ')}`);
  const iCycle = findCycle(new Map(items.map((i) => [i.id, i.after])));
  if (iCycle) errors.push(`item dependency cycle: ${iCycle.join(' → ')}`);

  if (errors.length) throw new Error(`plan.yaml has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  return { deliverables, items, workflows };
}

// ---------- status computation ----------

const finished = (s: ItemStoredStatus) => s === 'done' || s === 'skipped';
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const DAY = 864e5;

/**
 * Derive everything the dashboard and scheduler need: which deliverables are blocked and why,
 * which items are ready, risk against due dates, and per-workflow run history.
 * `released` maps pipeline id → released share (0-1).
 */
export function computePlan(
  raw: RawPlan, progress: Record<string, number>, now: number,
  /** Renders an item's output template for a deliverable (path inventory lookup). */
  renderOutput: (template: string, d: RawDeliverable) => string = (t) => t,
): {
  deliverables: Deliverable[]; workflows: Workflow[];
} {
  const byId = new Map(raw.deliverables.map((d) => [d.id, d]));
  const itemsOf = new Map<string, RawItem[]>();
  for (const it of raw.items) {
    const list = itemsOf.get(it.deliverableId) ?? [];
    list.push(it);
    itemsOf.set(it.deliverableId, list);
  }
  const itemById = new Map(raw.items.map((i) => [i.id, i]));
  const lastRun = new Map<string, WorkflowRun>();
  for (const r of raw.runs) if (r.itemId && !lastRun.has(r.itemId)) lastRun.set(r.itemId, r);

  const isDone = (id: string) => {
    const its = itemsOf.get(id) ?? [];
    return its.length > 0 && its.every((i) => finished(i.status));
  };

  const deliverables: Deliverable[] = [...raw.deliverables]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => {
      const gates: Gate[] = d.gates.map((g) => {
        const current = progress[progressKey(g.pipelineId, g.stepKey)] ?? 0;
        return { pipelineId: g.pipelineId, stepKey: g.stepKey, threshold: g.threshold, current, met: current >= g.threshold };
      });
      const blockedBy = [
        ...d.dependsOn.filter((id) => !isDone(id)).map((id) => `Waiting for “${byId.get(id)?.title ?? id}”`),
        ...gates.filter((g) => !g.met).map((g) => `${g.pipelineId} ${g.stepKey ? `past ${g.stepKey}` : 'complete'}: ${pct(g.current)} of ${pct(g.threshold)} needed`),
      ];
      const open = blockedBy.length === 0;
      const raws = [...(itemsOf.get(d.id) ?? [])].sort((a, b) => a.ordinal - b.ordinal);
      const items: WorkItem[] = raws.map((it) => {
        let status: ItemStatus;
        let reasons: string[] = [];
        if (it.status !== 'todo') status = it.status;
        else if (!open) { status = 'blocked'; reasons = blockedBy; }
        else {
          const waiting = it.after.filter((a) => !finished(itemById.get(a)?.status ?? 'todo'));
          reasons = waiting.map((a) => `Waiting for “${itemById.get(a)?.title ?? a}”`);
          status = waiting.length ? 'blocked' : 'ready';
        }
        return {
          id: it.id, deliverableId: it.deliverableId, ordinal: it.ordinal, title: it.title, mode: it.mode,
          workflowId: it.workflowId, assignee: it.assignee, storedStatus: it.status, status,
          dueDate: it.dueDate, after: it.after, blockedBy: reasons, lastRun: lastRun.get(it.id) ?? null,
          outputTemplate: it.outputTemplate,
          outputPath: it.outputOverride ?? (it.outputTemplate ? renderOutput(it.outputTemplate, d) : null),
        };
      });
      const done = items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
      const total = items.length;
      let state: DeliverableState;
      if (total > 0 && done === total) state = 'done';
      else if (!open) state = 'blocked';
      else if (items.some((i) => i.status === 'in_progress' || i.status === 'done' || i.status === 'failed')) state = 'in_progress';
      else state = 'ready';
      let risk: Risk = 'ok';
      if (state !== 'done' && d.dueDate) {
        const due = Date.parse(`${d.dueDate}T23:59:59`);
        if (due < now) risk = 'late';
        else if (due - now < 21 * DAY && (state === 'blocked' || done / Math.max(1, total) < 0.5)) risk = 'at_risk';
      }
      return {
        id: d.id, title: d.title, study: d.study, kind: d.kind, description: d.description, owner: d.owner,
        dueDate: d.dueDate, release: d.release, raci: d.raci, dependsOn: d.dependsOn,
        neededBy: raw.deliverables.filter((x) => x.dependsOn.includes(d.id)).map((x) => x.id),
        gates, state, risk, blockedBy, done, total, items,
      };
    });

  const workflows: Workflow[] = raw.workflows.map((w) => {
    const runs = raw.runs.filter((r) => r.workflowId === w.id);
    const fin = runs.filter((r) => r.status === 'succeeded' || r.status === 'failed');
    return {
      ...w,
      usedBy: raw.items.filter((i) => i.workflowId === w.id).map((i) => i.id),
      recentRuns: runs.slice(0, 8),
      successRate: fin.length ? fin.filter((r) => r.status === 'succeeded').length / fin.length : null,
      active: runs.filter((r) => r.status === 'queued' || r.status === 'running').length,
    };
  });

  return { deliverables, workflows };
}

/** Minimal pipeline shape for progress shares (a PipelineStatus fits). */
export interface ProgressPipeline {
  id: string; expected: number; released: number;
  steps: { key: string; queued: number; running: number; failed: number }[];
}

/**
 * Progress shares: `pipeline` = share complete; `pipeline#step` = share of units past that step
 * (at a later step or complete). Excluded units are not counted.
 */
export function progressFromPipelines(pipelines: ProgressPipeline[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of pipelines) {
    const n = p.expected || 1;
    out[p.id] = p.released / n;
    let later = p.released;
    for (let i = p.steps.length - 1; i >= 0; i--) {
      out[`${p.id}#${p.steps[i].key}`] = later / n;
      later += p.steps[i].queued + p.steps[i].running + p.steps[i].failed;
    }
  }
  return out;
}

/** Key into the progress map: share of a pipeline's units past a step, or complete when step is null. */
export const progressKey = (pipelineId: string, stepKey: string | null) => (stepKey ? `${pipelineId}#${stepKey}` : pipelineId);

/** Automated items the scheduler should start now: ready, workflow triggers on_ready, nothing in flight. */
export function itemsToTrigger(deliverables: Deliverable[], workflows: Workflow[]): WorkItem[] {
  const trig = new Map(workflows.map((w) => [w.id, w.trigger]));
  return deliverables.flatMap((d) => d.items).filter((i) =>
    i.mode === 'automated' && i.status === 'ready' && i.workflowId && trig.get(i.workflowId) === 'on_ready');
}

/** Fill a workflow command template. */
export function renderCommand(command: string, ctx: { study: string | null; deliverable: string; item: string; runId: number }) {
  return command
    .replaceAll('{study}', ctx.study ?? 'multi')
    .replaceAll('{deliverable}', ctx.deliverable)
    .replaceAll('{item}', ctx.item)
    .replaceAll('{run_id}', String(ctx.runId));
}
