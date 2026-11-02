// Wire types shared by the server API and the React client.
import type { ModalityKey, PipelineKind, Role } from './catalog';

export type UnitState = 'expected' | 'queued' | 'running' | 'failed' | 'released' | 'excluded';

export type EventKind =
  | 'arrive'      // units received from the source
  | 'start'       // automated step started
  | 'done'        // automated step completed
  | 'fail'        // units failed at a step
  | 'decision'    // a person passed or excluded units at a manual step
  | 'assign'      // a batch or item was assigned, claimed or returned
  | 'task'        // a new batch was created for a manual step
  | 'retry'       // failed units were requeued
  | 'item'        // a deliverable work item changed status
  | 'run'         // a workflow run was queued, started or finished
  | 'deliverable'; // a deliverable was unblocked, completed or changed owner

export interface StepStatus {
  key: string;
  name: string;
  ordinal: number;
  mode: 'auto' | 'manual';
  role: Role | null;
  slaDays: number | null;
  /** Who starts processing at an automated step. */
  launch: 'scheduler' | 'external';
  queued: number;
  running: number;
  failed: number;
  /** Processing runs queued or running at this step. */
  activeRuns: number;
}

export interface PipelineStatus {
  id: string;
  study: string;
  modality: ModalityKey;
  kind: PipelineKind;
  engine: string;
  version: string;
  source: string;
  /** All units except excluded ones. */
  expected: number;
  notReceived: number;
  released: number;
  excluded: number;
  steps: StepStatus[];
  /** Per-study scheduler settings from studies.yaml. */
  settings: { batchSize: number; maxActiveRuns: number; autoRetry: number; qcBatchSize: number };
}

export interface Task {
  id: number;
  pipelineId: string;
  study: string;
  modality: ModalityKey;
  stepKey: string;
  stepName: string;
  label: string;
  role: Role;
  slaDays: number;
  n: number;
  createdAt: string;
  dueAt: string;
  assignee: string | null;
}

export interface TrackerEvent {
  id: number;
  at: string;
  pipelineId: string | null;
  deliverableId: string | null;
  study: string | null;
  modality: ModalityKey | null;
  stepKey: string | null;
  kind: EventKind;
  actor: string;
  n: number;
  text: string;
}

export interface Person { name: string; role: Role }

export interface StudySummary { id: string; name: string; source: string; team: { person: string; role: Role }[] }

// ---------- deliverables ----------

export type DeliverableKind = 'data_release' | 'derivative' | 'analysis' | 'report' | 'infrastructure';
export type ItemMode = 'manual' | 'automated';
/** What is stored. */
export type ItemStoredStatus = 'todo' | 'in_progress' | 'done' | 'failed' | 'skipped';
/** What is shown: a "todo" item is either blocked or ready. */
export type ItemStatus = Exclude<ItemStoredStatus, 'todo'> | 'blocked' | 'ready';
export type DeliverableState = 'blocked' | 'ready' | 'in_progress' | 'done';
export type Risk = 'ok' | 'at_risk' | 'late';
export type Raci = 'R' | 'A' | 'C' | 'I';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type WorkflowTrigger = 'on_ready' | 'manual';

export interface Gate { pipelineId: string; threshold: number; current: number; met: boolean }

/** A deliverable run (workflowId + itemId) or a processing run (pipelineId + stepKey + n units). */
export interface WorkflowRun {
  id: number;
  engine: string;
  workflowId: string | null;
  itemId: string | null;
  pipelineId: string | null;
  stepKey: string | null;
  n: number;
  status: RunStatus;
  triggeredBy: string;
  worker: string | null;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkItem {
  id: string;            // "<deliverable>/<item>"
  deliverableId: string;
  ordinal: number;
  title: string;
  mode: ItemMode;
  workflowId: string | null;
  assignee: string | null;
  storedStatus: ItemStoredStatus;
  status: ItemStatus;
  dueDate: string | null;
  after: string[];       // item ids
  blockedBy: string[];   // readable reasons
  lastRun: WorkflowRun | null;
}

export interface Deliverable {
  id: string;
  title: string;
  study: string | null;
  kind: DeliverableKind;
  description: string | null;
  owner: string;
  dueDate: string | null;
  raci: { person: string; role: Raci }[];
  dependsOn: string[];
  neededBy: string[];
  gates: Gate[];
  state: DeliverableState;
  risk: Risk;
  blockedBy: string[];
  done: number;
  total: number;
  items: WorkItem[];
}

export interface Workflow {
  id: string;
  name: string;
  engine: string;
  trigger: WorkflowTrigger;
  maintainer: string;
  command: string;
  description: string | null;
  usedBy: string[];      // item ids
  recentRuns: WorkflowRun[];
  successRate: number | null;
  active: number;
}

export interface Snapshot {
  generatedAt: string;
  studies: StudySummary[];
  people: Person[];
  pipelines: PipelineStatus[];
  tasks: Task[];
  events: TrackerEvent[];
  deliverables: Deliverable[];
  workflows: Workflow[];
  runs: WorkflowRun[];   // newest first
}

export interface ItemPatch { assignee?: string | null; status?: 'todo' | 'in_progress' | 'done' | 'skipped' }
