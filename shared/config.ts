// Resolves shared/studies.yaml: defaults → study → modality. Pure; callers parse the YAML.
import {
  MODALITIES, MODALITY_KIND, ROLES, pipelineIdFor,
  type ModalityKey, type PersonDef, type PipelineKind, type Role,
} from './catalog';

export type Launch = 'scheduler' | 'external';

export interface StepDef {
  key: string; name: string; mode: 'auto' | 'manual'; role?: Role; sla_days?: number;
  task_label?: string; exclude_reason?: string; command?: string; launch?: Launch;
  /** Path template for this step's output; its existence on disk marks the step done. */
  output?: string;
}
export interface StepOverride extends Partial<Omit<StepDef, 'key' | 'mode'>> { skip?: boolean }
export interface SchedulerSettings {
  batch_size?: number | 'auto'; max_active_runs_per_step?: number; auto_retry?: number; qc_batch_size?: number;
}
export interface ModalityConfig {
  units: number; engine?: string; version?: string;
  paths?: Record<string, string>;
  steps?: Record<string, StepOverride>;
  add_steps?: (StepDef & { after: string })[];
  scheduler?: SchedulerSettings;
}
export interface StudyConfig {
  id: string; name: string; source: string;
  host?: string;
  release?: string;
  visits?: string[];
  paths?: Record<string, string>;
  team?: Partial<Record<Role, string[]>>;
  scheduler?: SchedulerSettings;
  steps?: Record<string, StepOverride>;
  modalities: Partial<Record<ModalityKey, ModalityConfig>>;
  /** Demo data only: activity weight and starting shares. */
  sim?: { activity?: number; released?: number; not_received?: number };
}
export interface ConfigDoc {
  people: PersonDef[];
  defaults: {
    launch?: Launch;
    host?: string;
    paths?: Record<string, string>;
    scheduler: SchedulerSettings;
    pipelines: Partial<Record<PipelineKind, { engine?: string; version?: string; steps: StepDef[] }>>;
  };
  studies: StudyConfig[];
}

export interface ResolvedStep {
  key: string; name: string; mode: 'auto' | 'manual'; role: Role | null; slaDays: number | null;
  taskLabel: string | null; excludeReason: string | null; command: string | null; launch: Launch;
  output: string | null;
}
export interface ResolvedScheduler {
  batchSize: number | 'auto'; maxActiveRunsPerStep: number; autoRetry: number; qcBatchSize: number;
}
export interface ResolvedPipeline {
  id: string; study: string; modality: ModalityKey; kind: PipelineKind; engine: string; version: string;
  units: number; steps: ResolvedStep[]; scheduler: ResolvedScheduler;
}
/** One entry of the path inventory. modality null = applies to every modality of the study. */
export interface LocationDef { study: string; modality: ModalityKey | null; key: string; path: string; host: string }
export interface ResolvedStudy {
  id: string; name: string; source: string; sortOrder: number; host: string; release: string; visits: string[];
  team: { person: string; role: Role }[];
  locations: LocationDef[];
  pipelines: ResolvedPipeline[];
  sim: { activity: number; released: number; notReceived: number };
}
export interface ResolvedConfig { people: PersonDef[]; studies: ResolvedStudy[] }

const MODS = new Set(MODALITIES.map((m) => m.key));
const IMAGING = new Set<ModalityKey>(['smri', 'dmri', 'fmri', 'pet']);
const KEY = /^[a-z][a-z0-9_]*$/;

/** Batch size for a pipeline once the number of expected units is known. */
export const effectiveBatchSize = (s: ResolvedScheduler, units: number) =>
  s.batchSize === 'auto' ? Math.max(5, Math.round(units / 200)) : s.batchSize;

/**
 * Template variables for one study and modality from the path inventory:
 * modality-specific entries win over study-wide ones.
 */
export function pathVars(
  locations: { modality: ModalityKey | null; key: string; path: string }[],
  ctx: { study: string; modality?: ModalityKey | null; release?: string | null; subject?: string; visit?: string; deliverable?: string },
): Record<string, string> {
  const vars: Record<string, string> = { study: ctx.study };
  if (ctx.release) vars.release = ctx.release;
  if (ctx.modality) vars.modality = ctx.modality;
  if (ctx.subject) vars.subject = ctx.subject;
  if (ctx.visit) vars.visit = ctx.visit;
  if (ctx.deliverable) vars.deliverable = ctx.deliverable;
  for (const l of locations) if (l.modality === null) vars[l.key] = l.path;
  for (const l of locations) if (ctx.modality && l.modality === ctx.modality) vars[l.key] = l.path;
  return vars;
}

export function resolveConfig(doc: ConfigDoc): ResolvedConfig {
  const errors: string[] = [];
  const people = doc.people ?? [];
  const names = new Set(people.map((p) => p.name));
  for (const p of people) if (!ROLES.includes(p.role)) errors.push(`person ${p.name}: unknown role "${p.role}"`);

  const baseSched: ResolvedScheduler = { batchSize: 'auto', maxActiveRunsPerStep: 2, autoRetry: 0, qcBatchSize: 50 };
  const mergeSched = (into: ResolvedScheduler, s: SchedulerSettings | undefined, where: string): ResolvedScheduler => {
    if (!s) return into;
    const out = { ...into };
    if (s.batch_size !== undefined) {
      if (s.batch_size !== 'auto' && !(Number.isInteger(s.batch_size) && s.batch_size > 0)) errors.push(`${where}: batch_size must be a positive integer or "auto"`);
      out.batchSize = s.batch_size;
    }
    if (s.max_active_runs_per_step !== undefined) out.maxActiveRunsPerStep = s.max_active_runs_per_step;
    if (s.auto_retry !== undefined) out.autoRetry = s.auto_retry;
    if (s.qc_batch_size !== undefined) out.qcBatchSize = s.qc_batch_size;
    if (out.maxActiveRunsPerStep < 1) errors.push(`${where}: max_active_runs_per_step must be at least 1`);
    if (out.autoRetry < 0) errors.push(`${where}: auto_retry cannot be negative`);
    return out;
  };
  const defSched = mergeSched(baseSched, doc.defaults?.scheduler, 'defaults.scheduler');
  const defLaunch: Launch = doc.defaults?.launch ?? 'scheduler';
  const checkPaths = (p: Record<string, string> | undefined, where: string) => {
    for (const [k, v] of Object.entries(p ?? {})) {
      if (!KEY.test(k)) errors.push(`${where}: path name "${k}" must be lower_case`);
      if (typeof v !== 'string' || !v.trim()) errors.push(`${where}: path "${k}" is empty`);
    }
  };
  checkPaths(doc.defaults?.paths, 'defaults.paths');

  const toStep = (s: StepDef): ResolvedStep => ({
    key: s.key, name: s.name, mode: s.mode, role: s.role ?? null, slaDays: s.sla_days ?? null,
    taskLabel: s.task_label ?? null, excludeReason: s.exclude_reason ?? null, command: s.command ?? null,
    launch: s.mode === 'manual' ? 'scheduler' : s.launch ?? defLaunch, output: s.output ?? null,
  });
  const applyOverride = (step: ResolvedStep, o: StepOverride, where: string): ResolvedStep | null => {
    if (o.skip) return null;
    if (o.role && !ROLES.includes(o.role)) errors.push(`${where}: unknown role "${o.role}"`);
    if (o.launch && o.launch !== 'scheduler' && o.launch !== 'external') errors.push(`${where}: launch must be scheduler or external`);
    return {
      ...step,
      name: o.name ?? step.name, role: o.role ?? step.role, slaDays: o.sla_days ?? step.slaDays,
      taskLabel: o.task_label ?? step.taskLabel, excludeReason: o.exclude_reason ?? step.excludeReason,
      command: o.command ?? step.command, launch: step.mode === 'manual' ? step.launch : o.launch ?? step.launch,
      output: o.output ?? step.output,
    };
  };

  const studies: ResolvedStudy[] = (doc.studies ?? []).map((s, order) => {
    const sw = `study ${s.id}`;
    const host = s.host ?? doc.defaults?.host ?? 'local';
    const team: { person: string; role: Role }[] = [];
    for (const [role, list] of Object.entries(s.team ?? {}) as [Role, string[]][]) {
      if (!ROLES.includes(role)) errors.push(`${sw}: unknown team role "${role}"`);
      for (const n of list ?? []) {
        if (!names.has(n)) errors.push(`${sw}: team member "${n}" is not in people`);
        team.push({ person: n, role });
      }
    }
    checkPaths(s.paths, `${sw}.paths`);
    const locations: LocationDef[] = Object.entries({ ...(doc.defaults?.paths ?? {}), ...(s.paths ?? {}) })
      .map(([key, path]) => ({ study: s.id, modality: null, key, path, host }));
    const studySched = mergeSched(defSched, s.scheduler, `${sw}.scheduler`);
    const pipelines: ResolvedPipeline[] = [];
    for (const [mod, mc] of Object.entries(s.modalities ?? {}) as [ModalityKey, ModalityConfig][]) {
      const mw = `${sw}.${mod}`;
      if (!MODS.has(mod)) { errors.push(`${mw}: unknown modality`); continue; }
      if (!(mc.units > 0)) errors.push(`${mw}: units must be positive`);
      checkPaths(mc.paths, `${mw}.paths`);
      for (const [key, path] of Object.entries(mc.paths ?? {})) locations.push({ study: s.id, modality: mod, key, path, host });
      const kind = MODALITY_KIND[mod];
      const base = doc.defaults?.pipelines?.[kind];
      if (!base) { errors.push(`${mw}: no default pipeline for "${kind}"`); continue; }
      let steps = base.steps.map(toStep);
      for (const a of mc.add_steps ?? []) {
        const i = steps.findIndex((x) => x.key === a.after);
        if (i < 0) { errors.push(`${mw}: add_steps "${a.key}" is after unknown step "${a.after}"`); continue; }
        if (steps.some((x) => x.key === a.key)) { errors.push(`${mw}: step "${a.key}" already exists`); continue; }
        steps.splice(i + 1, 0, toStep(a));
      }
      for (const layer of [s.steps, mc.steps]) {
        for (const [key, o] of Object.entries(layer ?? {})) {
          const known = steps.some((x) => x.key === key);
          // study-level overrides may name steps a given modality doesn't have; modality-level must match
          if (!known) { if (layer === mc.steps) errors.push(`${mw}: override for unknown step "${key}"`); continue; }
          steps = steps.map((x) => (x.key === key ? applyOverride(x, o, `${mw}.steps.${key}`) : x))
            .filter((x): x is ResolvedStep => x !== null);
        }
      }
      if (!steps.length) errors.push(`${mw}: every step was skipped`);
      for (const st of steps) if (st.mode === 'manual' && !st.role) errors.push(`${mw}: manual step "${st.key}" needs a role`);
      pipelines.push({
        id: pipelineIdFor(s.id, mod), study: s.id, modality: mod, kind,
        engine: mc.engine ?? base.engine ?? (IMAGING.has(mod) ? 'MMPS' : 'scripts'),
        version: mc.version ?? base.version ?? '—', units: mc.units, steps,
        scheduler: mergeSched(studySched, mc.scheduler, `${mw}.scheduler`),
      });
    }
    return {
      id: s.id, name: s.name, source: s.source, sortOrder: order, host, release: s.release ?? 'current',
      visits: s.visits?.length ? s.visits : ['ses-1'], team, locations, pipelines,
      sim: { activity: s.sim?.activity ?? 1, released: s.sim?.released ?? 0.5, notReceived: s.sim?.not_received ?? 0.1 },
    };
  });

  const ids = studies.map((s) => s.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) errors.push(`study ${dup}: duplicate id`);
  if (errors.length) throw new Error(`studies.yaml has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  return { people, studies };
}

/** Team members of a study with a role, falling back to everyone with that role. */
export function candidatesFor(cfg: ResolvedConfig, study: string, role: Role): string[] {
  const s = cfg.studies.find((x) => x.id === study);
  const team = s?.team.filter((t) => t.role === role).map((t) => t.person) ?? [];
  return team.length ? team : cfg.people.filter((p) => p.role === role).map((p) => p.name);
}
