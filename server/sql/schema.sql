-- Cohort Data Tracker schema (Postgres 14+)
-- A work_unit is one session in one pipeline. Its step_key + state say where it is now.
-- The event table is the append-only audit trail of every change.

CREATE TABLE IF NOT EXISTS study (
  study_id text PRIMARY KEY,                 -- 'ABCD', 'HBCD', 'UKB', ...
  name     text NOT NULL,
  source   text NOT NULL,                    -- where the data comes from, e.g. 'NDA (on disk)'
  host     text NOT NULL DEFAULT 'local',    -- where the data lives: local, TSD, HUNT Cloud, ...
  release  text,                             -- current release, used in path templates as {release}
  visits   text[] NOT NULL DEFAULT '{}',
  sort_order int NOT NULL DEFAULT 0,          -- display order on the dashboard
  dua_ref  text                              -- data use agreement / access tier
);

CREATE TABLE IF NOT EXISTS person (
  name text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('study_lead','qc_reviewer','data_manager','genomics_analyst','lab_liaison'))
);

-- Who works on each study, by role. The scheduler auto-assigns review batches within this team.
CREATE TABLE IF NOT EXISTS study_team (
  study_id text REFERENCES study ON DELETE CASCADE,
  person   text REFERENCES person ON DELETE CASCADE,
  role     text NOT NULL,
  PRIMARY KEY (study_id, person, role)
);

-- Editable inventory of where each study's data lives, by modality (NULL = all modalities).
-- Seeded from studies.yaml; edited on the dashboard. Step and item path templates refer to these by key.
CREATE TABLE IF NOT EXISTS data_location (
  location_id bigserial PRIMARY KEY,
  study_id    text NOT NULL REFERENCES study ON DELETE CASCADE,
  modality    text,
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  path        text NOT NULL,
  host        text NOT NULL DEFAULT 'local',
  description text,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS data_location_key ON data_location (study_id, COALESCE(modality, ''), key);

CREATE TABLE IF NOT EXISTS participant (
  study_id       text REFERENCES study,
  participant_id text,
  site           text,
  PRIMARY KEY (study_id, participant_id)
);

CREATE TABLE IF NOT EXISTS session (
  session_id     text PRIMARY KEY,           -- e.g. ABCD/P0000001/ses-1
  study_id       text NOT NULL,
  participant_id text NOT NULL,
  visit          text NOT NULL,
  acq_date       date,
  FOREIGN KEY (study_id, participant_id) REFERENCES participant
);

-- One pipeline per study x modality, resolved from studies.yaml (spec keeps the resolved definition).
CREATE TABLE IF NOT EXISTS pipeline (
  pipeline_id     text PRIMARY KEY,          -- 'abcd-dmri'
  study_id        text NOT NULL REFERENCES study,
  modality        text NOT NULL CHECK (modality IN ('smri','dmri','fmri','pet','eeg','genomics','biospecimen','assessment')),
  kind            text NOT NULL,
  engine          text NOT NULL,
  version         text NOT NULL,
  spec            jsonb NOT NULL,
  -- scheduler settings (per study / modality in studies.yaml)
  batch_size      int NOT NULL DEFAULT 10,   -- units per processing run
  max_active_runs int NOT NULL DEFAULT 2,    -- concurrent processing runs per step
  auto_retry      int NOT NULL DEFAULT 1,    -- automatic requeues of a failed unit
  qc_batch_size   int NOT NULL DEFAULT 50,   -- units per manual review batch
  UNIQUE (study_id, modality)
);

CREATE TABLE IF NOT EXISTS step (
  pipeline_id    text REFERENCES pipeline ON DELETE CASCADE,
  step_key       text,
  ordinal        int  NOT NULL,
  name           text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('auto','manual')),
  role           text,                       -- who decides a manual step
  sla_days       int,
  task_label     text,
  exclude_reason text,
  command        text,                       -- template for processing runs: {pipeline} {step} {run_id} {study}
  output         text,                       -- path template of the step's output; exists on disk = step done
  -- who starts processing at an automated step: the tracker's scheduler, or an external engine
  -- that reports progress itself through POST /api/events
  launch         text NOT NULL DEFAULT 'scheduler' CHECK (launch IN ('scheduler','external')),
  PRIMARY KEY (pipeline_id, step_key),
  UNIQUE (pipeline_id, ordinal)
);

CREATE TABLE IF NOT EXISTS work_unit (
  unit_id     bigserial PRIMARY KEY,
  session_id  text NOT NULL REFERENCES session,
  pipeline_id text NOT NULL REFERENCES pipeline,
  step_key    text,                          -- NULL while state = 'expected'
  state       text NOT NULL CHECK (state IN ('expected','queued','running','failed','released','excluded')),
  input_hash  text,                          -- re-run when inputs or pipeline version change
  attempts    int NOT NULL DEFAULT 0,        -- failures so far at the current step
  paths       jsonb NOT NULL DEFAULT '{}',   -- actual output paths by step, when they differ from the template
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, pipeline_id),
  FOREIGN KEY (pipeline_id, step_key) REFERENCES step
);
CREATE INDEX IF NOT EXISTS work_unit_position ON work_unit (pipeline_id, step_key, state);

-- Batches of manual work handed to people
CREATE TABLE IF NOT EXISTS task (
  task_id     bigserial PRIMARY KEY,
  pipeline_id text NOT NULL,
  step_key    text NOT NULL,
  unit_ids    bigint[] NOT NULL,
  assignee    text REFERENCES person,
  created_at  timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  closed_at   timestamptz,
  closed_by   text,
  FOREIGN KEY (pipeline_id, step_key) REFERENCES step
);
CREATE INDEX IF NOT EXISTS task_open ON task (status, pipeline_id, step_key);
CREATE INDEX IF NOT EXISTS task_units ON task USING gin (unit_ids);

-- Append-only audit trail. One row per action; unit_ids lists every unit it touched.
CREATE TABLE IF NOT EXISTS event (
  event_id         bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  pipeline_id      text REFERENCES pipeline,
  step_key         text,
  unit_ids         bigint[] NOT NULL DEFAULT '{}',
  n                int NOT NULL DEFAULT 0,
  from_state       text,
  to_state         text,
  kind             text NOT NULL CHECK (kind IN ('arrive','start','done','fail','decision','assign','task','retry',
                                                 'item','run','deliverable','location')),
  actor            text NOT NULL,
  actor_kind       text NOT NULL CHECK (actor_kind IN ('pipeline','person','system')),
  software_version text,
  reason_code      text,
  note             text NOT NULL,
  -- set for deliverable events; no foreign keys so history survives a plan prune
  deliverable_id   text,
  item_id          text,
  run_id           bigint
);
CREATE INDEX IF NOT EXISTS event_units ON event USING gin (unit_ids);
CREATE INDEX IF NOT EXISTS event_pipeline ON event (pipeline_id, at);
CREATE INDEX IF NOT EXISTS event_deliverable ON event (deliverable_id, at);

-- ======================= Deliverables, responsibilities, workflows =======================
-- Defined in shared/plan.yaml and loaded with `npm run plan:load`.

-- Automatable workflows. trigger 'on_ready' starts a run as soon as an item using it is unblocked;
-- 'manual' waits for someone to press Run.
CREATE TABLE IF NOT EXISTS workflow (
  workflow_id text PRIMARY KEY,
  name        text NOT NULL,
  engine      text NOT NULL,                 -- nextflow | slurm | python | script | ... (workers claim by engine)
  trigger     text NOT NULL CHECK (trigger IN ('external','on_ready','manual')),
  maintainer  text NOT NULL REFERENCES person,
  command     text NOT NULL,                 -- template: {study} {deliverable} {item} {run_id}
  description text
);

CREATE TABLE IF NOT EXISTS deliverable (
  deliverable_id text PRIMARY KEY,
  title          text NOT NULL,
  study_id       text REFERENCES study,      -- NULL for cross-study deliverables
  kind           text NOT NULL CHECK (kind IN ('data_release','derivative','analysis','report','infrastructure')),
  description    text,
  owner          text NOT NULL REFERENCES person,   -- the single Accountable person
  due_date       date,
  release        text,                       -- {release} in output path templates
  sort_order     int NOT NULL DEFAULT 0,
  last_state     text                        -- scheduler bookkeeping, to log state changes once
);

-- Deliverable B cannot start until deliverable A is done
CREATE TABLE IF NOT EXISTS deliverable_dependency (
  deliverable_id text REFERENCES deliverable ON DELETE CASCADE,
  depends_on     text REFERENCES deliverable ON DELETE CASCADE,
  PRIMARY KEY (deliverable_id, depends_on),
  CHECK (deliverable_id <> depends_on)
);

-- Deliverable cannot start until this share of a pipeline's units is past step_key ('' = complete)
CREATE TABLE IF NOT EXISTS deliverable_gate (
  deliverable_id text REFERENCES deliverable ON DELETE CASCADE,
  pipeline_id    text REFERENCES pipeline,
  step_key       text NOT NULL DEFAULT '',
  min_released   numeric NOT NULL CHECK (min_released > 0 AND min_released <= 1),
  PRIMARY KEY (deliverable_id, pipeline_id, step_key)
);

CREATE TABLE IF NOT EXISTS deliverable_raci (
  deliverable_id text REFERENCES deliverable ON DELETE CASCADE,
  person         text REFERENCES person,
  raci           char(1) NOT NULL CHECK (raci IN ('R','A','C','I')),
  PRIMARY KEY (deliverable_id, person, raci)
);

-- The steps that produce a deliverable: manual (assigned to a person) or automated (runs a workflow)
CREATE TABLE IF NOT EXISTS work_item (
  item_id        text PRIMARY KEY,           -- '<deliverable>/<item>'
  deliverable_id text NOT NULL REFERENCES deliverable ON DELETE CASCADE,
  ordinal        int NOT NULL,
  title          text NOT NULL,
  mode           text NOT NULL CHECK (mode IN ('manual','automated')),
  workflow_id    text REFERENCES workflow,
  assignee       text REFERENCES person,     -- who does it (manual) or runs it (automated)
  status         text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','failed','skipped')),
  output_template text,                      -- where the result goes (path inventory names, {release}, {deliverable})
  output_path    text,                       -- actual path recorded when it differs from the template
  due_date       date,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'automated') = (workflow_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS work_item_dependency (
  item_id    text REFERENCES work_item ON DELETE CASCADE,
  depends_on text REFERENCES work_item ON DELETE CASCADE,
  PRIMARY KEY (item_id, depends_on),
  CHECK (item_id <> depends_on)
);

-- Every execution the scheduler launches. Two kinds:
--   deliverable runs: a workflow for one work item (item_id set)
--   processing runs:  a batch of units at an automated pipeline step (pipeline_id, step_key, unit_ids set)
-- Workers claim queued runs by engine and report the outcome.
CREATE TABLE IF NOT EXISTS workflow_run (
  run_id       bigserial PRIMARY KEY,
  engine       text NOT NULL,
  workflow_id  text REFERENCES workflow,
  item_id      text REFERENCES work_item ON DELETE CASCADE,
  pipeline_id  text REFERENCES pipeline,
  step_key     text,
  unit_ids     bigint[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  triggered_by text NOT NULL,
  worker       text,
  message      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  CHECK ((item_id IS NOT NULL AND workflow_id IS NOT NULL) <> (pipeline_id IS NOT NULL AND step_key IS NOT NULL)),
  FOREIGN KEY (pipeline_id, step_key) REFERENCES step
);
CREATE INDEX IF NOT EXISTS workflow_run_step ON workflow_run (pipeline_id, step_key, status);
CREATE INDEX IF NOT EXISTS workflow_run_status ON workflow_run (status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_one_active ON workflow_run (item_id)
  WHERE status IN ('queued','running');

-- Every new event notifies listeners (the API server relays it to dashboards over SSE)
CREATE OR REPLACE FUNCTION notify_tracker() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('tracker', NEW.event_id::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_notify ON event;
CREATE TRIGGER event_notify AFTER INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION notify_tracker();

-- Reporting views
CREATE OR REPLACE VIEW status_by_step AS
SELECT p.study_id, p.modality, w.step_key, s.ordinal, w.state, count(*)::int AS n
FROM work_unit w
JOIN pipeline p USING (pipeline_id)
LEFT JOIN step s USING (pipeline_id, step_key)
GROUP BY 1, 2, 3, 4, 5;

CREATE OR REPLACE VIEW overdue_tasks AS
SELECT * FROM task WHERE status = 'open' AND due_at < now();

-- Everyone's open manual work items
CREATE OR REPLACE VIEW open_items_by_person AS
SELECT i.assignee, i.item_id, i.title, d.title AS deliverable, COALESCE(i.due_date, d.due_date) AS due
FROM work_item i JOIN deliverable d USING (deliverable_id)
WHERE i.mode = 'manual' AND i.status IN ('todo','in_progress');

-- Full history of one unit:
--   SELECT * FROM event WHERE unit_ids @> ARRAY[<unit_id>]::bigint[] ORDER BY at;
