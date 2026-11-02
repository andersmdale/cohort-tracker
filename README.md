# Cohort Data Tracker

Tracks the data for ABCD, HBCD, UKB, ADNI, PING, VETSA, TOP and HUNT:

- where each study's data lives, in an editable path inventory by study and modality
- every subject × visit, from raw data on disk through MMPS processing, FreeSurfer, NeuroQuant, QC,
  ROI extraction and atlas registration
- release-level work: ROI spreadsheets, voxelwise/vertexwise concatenation across subjects and visits,
  SVD, FEMA maps; with dependencies, output paths, owners and RACI roles
- each person's pending tasks: review batches, deliverable tasks and the scripts they run

Right now the tracker **tracks** work; it does not launch jobs. People and existing scripts do the work, and
`npm run scan` checks the expected output paths on disk to record progress.

```
shared/studies.yaml   people, path inventory defaults, visits, processing steps per modality, per-study overrides
shared/plan.yaml      release-level deliverables, dependencies, gates, owners/RACI, items, scripts
shared/*.ts           types, config resolution, plan logic (server and client)
server/               Express + Postgres API, live updates, import / scan scripts
client/               React + TypeScript dashboard
```

## Dashboard

| Tab | What it shows |
|---|---|
| Pipelines | Share complete per study × modality; per-step counts and output path templates |
| Subjects | Search a subject id: status of every visit and modality, with the path of each step's output |
| Paths | The path inventory: edit, add or remove entries; see what each resolves to and how many templates use it |
| Deliverables | Dependency graph, gates on per-step progress, RACI, items with output paths and who does them |
| Tasks | Each person's review batches and deliverable tasks; team load |
| Scripts | The scripts behind deliverable items, who maintains and runs them |
| Event log | Every change, including path edits, with who made it |

## Paths

Step outputs are templates such as `{mmps_root}/MRIPROC_{subject}_{visit}`. Names like `mmps_root` come from the
path inventory: study-wide entries, overridden by modality-specific ones. Entries can use `{study}`, `{release}` and
other names. Edit them on the **Paths** tab; every derived per-subject and per-release path follows.
`studies.yaml` only seeds the inventory: `npm run config:load` adds new names but keeps edited entries
(`--paths` overwrites them).

## Getting real data in

Run these on the machine that holds the data (they read the filesystem and write to the tracker's database).

1. Start from an empty database: `npm run db:init` (or `npm run db:reset` for demo data).
2. Set each study's paths on the **Paths** tab.
3. Register subject × visit folders:
   `npm run import -- --study ABCD` finds every folder matching the first step's template (e.g. `{raw_root}/{subject}/{visit}`).
   For enclaves (TSD, HUNT Cloud) or any list you export: `npm run import -- --study TOP --modality smri --csv file.csv`
   with columns `subject,visit,completed_through` (a step key, `complete`, `expected`, or empty).
4. Record progress: `npm run scan` checks each step's output path for every subject × visit and moves units forward,
   and marks deliverable items done when their output exists. Run it after batches finish or nightly from cron.
   Use `--study`, `--modality`, `--host TSD` (inside an enclave) and `--dry-run` as needed.

Manual steps (QC) have no file; reviewers record them in the Tasks tab, where review batches are created
automatically and assigned to the least-loaded reviewer on the study's team.

## Configuration

- `shared/studies.yaml`: per study `paths`, `visits`, `release`, `host`, team; per modality step overrides
  (`name`, `output`, `sla_days`, `skip`), `add_steps` (e.g. HBCD infant segmentation). Apply with `npm run config:load`;
  adding or removing steps needs `npm run db:reset`.
- `shared/plan.yaml`: deliverables with `depends_on`, `gates` (`{ pipeline, step, done }`: share of units past a step),
  items (`manual`, or `automated` with a `workflow` script and an `assignee` who runs it) and `output` paths.
  Apply with `npm run plan:load`.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/snapshot`, `/api/stream` | Dashboard state; live change feed |
| GET | `/api/units?study=&modality=&subject=` | Subject × visit status and per-step paths |
| POST, PATCH, DELETE | `/api/locations[/:id]` | Edit the path inventory |
| PATCH | `/api/items/:id` | Assign, set status, record `output_path` |
| POST | `/api/events` | Scripts report per-unit progress (`pipeline_id, step_key, session_ids, to_state`) |
| PATCH, POST | `/api/tasks/:id`, `/api/tasks/:id/complete` | Assign or pass review batches |

## Install on a Mac

```bash
unzip cohort-tracker.zip && cd cohort-tracker
bash install-mac.sh
```

Installs Node 22 and Postgres 16 with Homebrew when missing, creates the database, installs packages and seeds demo
data. Then double-click `Start Tracker.command`. Notes: unit counts, people and most paths are placeholders; there is no
authentication yet ("Acting as" is a dropdown).
