// Reads shared/studies.yaml and writes it into the database.
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type pg from 'pg';
import { effectiveBatchSize, resolveConfig, type ConfigDoc, type ResolvedConfig, type ResolvedPipeline } from '../../shared/config';

export const CONFIG_PATH = new URL('../../shared/studies.yaml', import.meta.url);

export function readConfig(path: URL | string = CONFIG_PATH): ResolvedConfig {
  return resolveConfig(YAML.parse(readFileSync(path, 'utf8')) as ConfigDoc);
}

async function upsertPeopleAndStudies(db: pg.PoolClient, cfg: ResolvedConfig) {
  for (const p of cfg.people) {
    await db.query(
      'INSERT INTO person (name, role) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET role = $2',
      [p.name, p.role],
    );
  }
  for (const s of cfg.studies) {
    await db.query(
      `INSERT INTO study (study_id, name, source, sort_order) VALUES ($1,$2,$3,$4)
       ON CONFLICT (study_id) DO UPDATE SET name = $2, source = $3, sort_order = $4`,
      [s.id, s.name, s.source, s.sortOrder],
    );
    await db.query('DELETE FROM study_team WHERE study_id = $1', [s.id]);
    for (const t of s.team) {
      await db.query('INSERT INTO study_team (study_id, person, role) VALUES ($1,$2,$3)', [s.id, t.person, t.role]);
    }
  }
}

function settings(p: ResolvedPipeline, units: number) {
  return [effectiveBatchSize(p.scheduler, units), p.scheduler.maxActiveRunsPerStep, p.scheduler.autoRetry, p.scheduler.qcBatchSize];
}

async function writeSteps(db: pg.PoolClient, p: ResolvedPipeline, insert: boolean) {
  for (const [i, st] of p.steps.entries()) {
    const args = [p.id, st.key, i + 1, st.name, st.mode, st.role, st.slaDays, st.taskLabel, st.excludeReason, st.command, st.launch];
    if (insert) {
      await db.query(
        `INSERT INTO step (pipeline_id, step_key, ordinal, name, mode, role, sla_days, task_label, exclude_reason, command, launch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, args);
    } else {
      await db.query(
        `UPDATE step SET name = $4, role = $6, sla_days = $7, task_label = $8, exclude_reason = $9, command = $10, launch = $11
          WHERE pipeline_id = $1 AND step_key = $2 AND ordinal = $3 AND mode = $5`, args);
    }
  }
}

/** Seed path: create people, studies, teams, pipelines and steps. `units` gives the scaled unit count per pipeline. */
export async function createFromConfig(db: pg.PoolClient, cfg: ResolvedConfig, units: (p: ResolvedPipeline) => number) {
  await upsertPeopleAndStudies(db, cfg);
  for (const s of cfg.studies) {
    for (const p of s.pipelines) {
      await db.query(
        `INSERT INTO pipeline (pipeline_id, study_id, modality, kind, engine, version, spec,
                               batch_size, max_active_runs, auto_retry, qc_batch_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [p.id, p.study, p.modality, p.kind, p.engine, p.version, JSON.stringify(p), ...settings(p, units(p))],
      );
      await writeSteps(db, p, true);
    }
  }
}

/**
 * config:load path: update settings on a live database. Refuses structural changes
 * (new studies or modalities, added, removed or reordered steps), which need a reseed.
 */
export async function updateFromConfig(db: pg.PoolClient, cfg: ResolvedConfig) {
  const problems: string[] = [];
  const existing = await db.query<{ pipeline_id: string; n: number }>(
    'SELECT p.pipeline_id, count(w.unit_id)::int AS n FROM pipeline p LEFT JOIN work_unit w USING (pipeline_id) GROUP BY 1');
  const unitsBy = new Map(existing.rows.map((r) => [r.pipeline_id, r.n]));
  const stepRows = await db.query<{ pipeline_id: string; step_key: string; mode: string }>(
    'SELECT pipeline_id, step_key, mode FROM step ORDER BY pipeline_id, ordinal');
  const stepsBy = new Map<string, string[]>();
  for (const r of stepRows.rows) stepsBy.set(r.pipeline_id, [...(stepsBy.get(r.pipeline_id) ?? []), `${r.step_key}:${r.mode}`]);

  for (const s of cfg.studies) {
    for (const p of s.pipelines) {
      const have = stepsBy.get(p.id);
      if (!have) { problems.push(`${p.id} is new`); continue; }
      const want = p.steps.map((x) => `${x.key}:${x.mode}`);
      if (have.join(',') !== want.join(',')) {
        problems.push(`${p.id} steps changed (${have.map((x) => x.split(':')[0]).join(' → ')}  ⇒  ${p.steps.map((x) => x.key).join(' → ')})`);
      }
    }
  }
  if (problems.length) {
    throw new Error(`These changes need a reseed (npm run db:reset):\n  - ${problems.join('\n  - ')}`);
  }
  await upsertPeopleAndStudies(db, cfg);
  let n = 0;
  for (const s of cfg.studies) {
    for (const p of s.pipelines) {
      await db.query(
        `UPDATE pipeline SET engine = $2, version = $3, spec = $4, batch_size = $5, max_active_runs = $6,
                auto_retry = $7, qc_batch_size = $8 WHERE pipeline_id = $1`,
        [p.id, p.engine, p.version, JSON.stringify(p), ...settings(p, unitsBy.get(p.id) ?? 0)],
      );
      await writeSteps(db, p, false);
      n++;
    }
  }
  return n;
}
