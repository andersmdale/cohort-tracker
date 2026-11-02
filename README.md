# Cohort Data Tracker

The tracker covers data import, processing and deliverables for ABCD, HBCD, UKB, ADNI, PING, VETSA, TOP and HUNT. It does four things:

- **Configures each study.** Every study gets its own settings.
- **Tracks deliverables.** It records dependencies between deliverables, who is responsible for what, and which steps are automated workflows.
- **Launches work automatically.** A scheduler starts processing, review batches and workflows as soon as their dependencies are met.
- **Shows status live.** A dashboard reflects every change as it happens.

```
shared/studies.yaml   people, default pipelines per data type, per-study and per-modality overrides
shared/plan.yaml      deliverables, dependencies, gates, owners/RACI, work items, workflows
shared/*.ts           types, config resolution, plan logic (used by server and client)
server/               Express + Postgres API, SSE stream, scheduler, worker, seed, simulator
client/               React + TypeScript dashboard (Vite)
```

## Per-study configuration (`shared/studies.yaml`)

Settings resolve in three layers: `defaults`, then `study`, then `study.modalities.<modality>`. Later layers win. Per study or per modality you can set:

- **Steps:**
  - rename, retarget (`command`), change the SLA or role, or `skip` a step
  - `add_steps` (for example ABCD fMRI offline recon, HBCD infant segmentation)
  - `launch: scheduler | external`
    - `scheduler`: the tracker launches processing runs for the step.
    - `external`: the study's own engine runs the step and reports through `POST /api/events` (for example TOP MRI inside TSD).
- **Engine and version.**
- **Scheduler settings:**
  - `batch_size`: units per processing run
  - `max_active_runs_per_step`: concurrency
  - `auto_retry`: automatic requeues of failed units
  - `qc_batch_size`: review batch size
- **Team:** who is auto-assigned review batches for that study, by role.

`npm run config:load` applies changes to settings on a live database. Changing which steps a pipeline has needs `npm run db:reset`; the loader says so and changes nothing.

## Deliverables (`shared/plan.yaml`)

- **Dependencies:**
  - `depends_on`: other deliverables that must be done first
  - `gates`: a pipeline must reach a released share first, for example `abcd-dmri ≥ 72%`
  - `after`: ordering of items within a deliverable
  - Cycles are rejected when the file is loaded.
- **Responsibility:**
  - `owner` is the single Accountable person.
  - `raci` adds Responsible, Consulted and Informed people.
  - Manual items have an `assignee`, which can be changed live on the dashboard.
- **Automation:**
  - Automated items run a `workflow`.
  - `trigger: on_ready` starts the run as soon as the item is unblocked.
  - `trigger: manual` waits for someone to press Run (for example uploading to DEAP).
- **Reloading:** `npm run plan:load` updates definitions but keeps each item's live status and assignee. Add `--prune` to delete deliverables, items and workflows removed from the file.

## The scheduler (in the API server, every 3 s)

1. Requeues failed units that have retries left.
2. Batches units waiting at automated steps into processing runs, within each study's concurrency limit.
3. Batches units waiting at review steps. Each batch goes to the least-loaded team member with the right role.
4. Logs deliverables that become unblocked or done, and starts their `on_ready` workflow items.

Workers execute the queued runs. A worker claims runs by engine (`POST /api/workflow-runs/claim`) and reports the outcome (`/finish`). `npm run worker` is a reference worker: it runs each command through the shell and passes the batch of sessions in `$TRACKER_UNITS_FILE`. Run one worker per execution environment: a SLURM login node, a Nextflow host, the TSD gateway.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/snapshot`, `/api/stream` | Dashboard state; SSE change feed |
| POST | `/api/events` | External engines report unit transitions |
| POST | `/api/pipelines/:id/steps/:step/retry` | Requeue failed units |
| PATCH/POST | `/api/tasks/:id`, `/api/tasks/:id/complete` | Assign or pass review batches |
| PATCH | `/api/items/:id` | Assign a manual item, or start, complete or skip it |
| POST | `/api/items/:id/run` | Run a manual-trigger workflow, or retry a failed one |
| POST | `/api/workflow-runs/claim`, `/api/workflow-runs/:id/finish` | Worker protocol |
| GET | `/api/workflow-runs/:id` | Run details (command, sessions) |

## Notes

- Unit counts and people are placeholders. Replace the `people` and `team` entries in `studies.yaml` with your staff.
- There is no authentication: "Acting as" on the dashboard is a dropdown. Put the server behind SSO and take `actor` from the authenticated user.
- `npm run simulate` fakes the source adapters, the external engines, one worker and colleagues' actions. Don't run it against real data.

## Install on a Mac

```bash
unzip cohort-tracker.zip && cd cohort-tracker
bash install-mac.sh
```

The script uses Homebrew to install Node 22 and Postgres 16 if they are missing. It then creates the database, installs packages, seeds the data and prints the start commands. It writes the database connection string to `server/.env.local`.
