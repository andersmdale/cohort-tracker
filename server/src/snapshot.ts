// Builds the dashboard snapshot from the database in one round of queries.
import type { Db } from './db';
import type {
  PipelineStatus, Snapshot, StepStatus, Task, TrackerEvent, Person, StudySummary,
} from '../../shared/types';
import type { ModalityKey, PipelineKind, Role } from '../../shared/catalog';
import { computePlan, progressFromPipelines } from '../../shared/plan';
import { loadRawPlan, outputRenderer } from './plan';
import type { DataLocation } from '../../shared/types';

export async function buildSnapshot(db: Db, eventLimit = 200): Promise<Snapshot> {
  const [studies, people, pipes, steps, counts, tasks, events, active, raw, locs, render] = await Promise.all([
    db.query<StudySummary>(`SELECT s.study_id AS id, s.name, s.source, s.host, COALESCE(s.release, '') AS release, s.visits,
                                   COALESCE(json_agg(json_build_object('person', t.person, 'role', t.role)
                                            ORDER BY t.role, t.person) FILTER (WHERE t.person IS NOT NULL), '[]') AS team
                              FROM study s LEFT JOIN study_team t USING (study_id)
                             GROUP BY s.study_id ORDER BY s.sort_order, s.study_id`),
    db.query<Person>(`SELECT name, role FROM person ORDER BY role = 'study_lead' DESC, name`),
    db.query(`SELECT p.pipeline_id, p.study_id, p.modality, p.kind, p.engine, p.version, s.source,
                     p.batch_size, p.max_active_runs, p.auto_retry, p.qc_batch_size
                FROM pipeline p JOIN study s USING (study_id) ORDER BY p.pipeline_id`),
    db.query(`SELECT pipeline_id, step_key, ordinal, name, mode, role, sla_days, launch, output FROM step ORDER BY pipeline_id, ordinal`),
    db.query(`SELECT pipeline_id, step_key, state, count(*)::int AS n FROM work_unit GROUP BY 1, 2, 3`),
    db.query(`SELECT t.task_id, t.pipeline_id, t.step_key, cardinality(t.unit_ids) AS n, t.assignee,
                     t.created_at, t.due_at, p.study_id, p.modality, s.name AS step_name,
                     s.task_label, s.role, s.sla_days
                FROM task t
                JOIN pipeline p USING (pipeline_id)
                JOIN step s USING (pipeline_id, step_key)
               WHERE t.status = 'open' ORDER BY t.created_at`),
    db.query(`SELECT e.event_id, e.at, e.pipeline_id, e.deliverable_id, e.step_key, e.kind, e.actor, e.n, e.note,
                     COALESCE(p.study_id, d.study_id) AS study_id, p.modality
                FROM event e
                LEFT JOIN pipeline p USING (pipeline_id)
                LEFT JOIN deliverable d ON d.deliverable_id = e.deliverable_id
               ORDER BY e.event_id DESC LIMIT $1`, [eventLimit]),
    db.query(`SELECT pipeline_id, step_key, count(*)::int AS n FROM workflow_run
               WHERE status IN ('queued','running') AND pipeline_id IS NOT NULL GROUP BY 1, 2`),
    loadRawPlan(db),
    db.query(`SELECT l.location_id, l.study_id, l.modality, l.key, l.path, l.host, l.description, l.updated_by, l.updated_at
                FROM data_location l JOIN study s USING (study_id)
               ORDER BY s.sort_order, l.modality NULLS FIRST, l.key`),
    outputRenderer(db),
  ]);

  const byPipe = new Map<string, PipelineStatus>();
  for (const r of pipes.rows) {
    byPipe.set(r.pipeline_id, {
      id: r.pipeline_id, study: r.study_id, modality: r.modality as ModalityKey, kind: r.kind as PipelineKind,
      engine: r.engine, version: r.version, source: r.source,
      expected: 0, notReceived: 0, released: 0, excluded: 0, steps: [],
      settings: { batchSize: r.batch_size, maxActiveRuns: r.max_active_runs, autoRetry: r.auto_retry, qcBatchSize: r.qc_batch_size },
    });
  }
  const stepIndex = new Map<string, StepStatus>();
  for (const r of steps.rows) {
    const s: StepStatus = {
      key: r.step_key, name: r.name, ordinal: r.ordinal, mode: r.mode,
      role: (r.role as Role | null) ?? null, slaDays: r.sla_days, launch: r.launch, output: r.output, queued: 0, running: 0, failed: 0,
      activeRuns: 0,
    };
    byPipe.get(r.pipeline_id)?.steps.push(s);
    stepIndex.set(`${r.pipeline_id}|${r.step_key}`, s);
  }
  for (const r of counts.rows) {
    const p = byPipe.get(r.pipeline_id);
    if (!p) continue;
    const n: number = r.n;
    if (r.state === 'excluded') { p.excluded += n; continue; }
    p.expected += n;
    if (r.state === 'expected') p.notReceived += n;
    else if (r.state === 'released') p.released += n;
    else {
      const s = stepIndex.get(`${r.pipeline_id}|${r.step_key}`);
      if (s && (r.state === 'queued' || r.state === 'running' || r.state === 'failed')) s[r.state as 'queued' | 'running' | 'failed'] += n;
    }
  }

  for (const r of active.rows) {
    const s = stepIndex.get(`${r.pipeline_id}|${r.step_key}`);
    if (s) s.activeRuns = r.n;
  }

  const taskList: Task[] = tasks.rows.map((r) => ({
    id: Number(r.task_id), pipelineId: r.pipeline_id, study: r.study_id, modality: r.modality,
    stepKey: r.step_key, stepName: r.step_name, label: r.task_label ?? r.step_name,
    role: r.role as Role, slaDays: r.sla_days ?? 7, n: r.n,
    createdAt: new Date(r.created_at).toISOString(), dueAt: new Date(r.due_at).toISOString(),
    assignee: r.assignee,
  }));

  const eventList: TrackerEvent[] = events.rows.map((r) => ({
    id: Number(r.event_id), at: new Date(r.at).toISOString(), pipelineId: r.pipeline_id, deliverableId: r.deliverable_id,
    study: r.study_id, modality: r.modality, stepKey: r.step_key, kind: r.kind,
    actor: r.actor, n: r.n, text: r.note,
  }));

  const pipelines = [...byPipe.values()];
  const plan = computePlan(raw, progressFromPipelines(pipelines), Date.now(), render);
  const locations: DataLocation[] = locs.rows.map((r) => ({
    id: Number(r.location_id), study: r.study_id, modality: r.modality, key: r.key, path: r.path, host: r.host,
    description: r.description, updatedBy: r.updated_by, updatedAt: new Date(r.updated_at).toISOString(),
  }));

  return {
    generatedAt: new Date().toISOString(),
    studies: studies.rows,
    people: people.rows,
    pipelines,
    tasks: taskList,
    events: eventList,
    deliverables: plan.deliverables,
    workflows: plan.workflows,
    runs: raw.runs.slice(0, 150),
    locations,
  };
}
