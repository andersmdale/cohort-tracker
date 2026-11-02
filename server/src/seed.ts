// Creates the schema and loads studies (shared/studies.yaml) and the plan (shared/plan.yaml)
// with a synthetic starting state.
//   npm run db:reset                 # drop everything, recreate, seed at --scale 0.05
//   npm run db:reset -- --scale 0.2  # bigger
// Scale multiplies the configured expected units (UKB genomics 500k x 0.05 = 25k units).
import { readFileSync } from 'node:fs';
import { pool, tx } from './db';
import { mulberry32, seedDistribution } from '../../shared/catalog';
import { candidatesFor, type ResolvedPipeline } from '../../shared/config';
import { createTask } from './services';
import { createFromConfig, readConfig } from './config';
import { loadPlanFile } from './plan';
import { reconcile } from './scheduler';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
};
const reset = args.includes('--reset');
const scale = Number(flag('--scale') ?? 0.05);
if (!(scale > 0 && scale <= 1)) throw new Error('--scale must be between 0 and 1');

const schemaSql = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
const rand = mulberry32(20261101);
const scaled = (p: ResolvedPipeline) => Math.max(20, Math.round(p.units * scale));

async function main() {
  const cfg = readConfig(); // validate before touching the database
  if (reset) await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.query(schemaSql);
  const existing = await pool.query('SELECT count(*)::int AS n FROM study');
  if (existing.rows[0].n > 0) {
    throw new Error('The database already has studies. Run "npm run db:reset" to wipe and reseed.');
  }

  await tx((c) => createFromConfig(c, cfg, scaled));

  for (const s of cfg.studies) {
    const t0 = Date.now();
    await tx(async (c) => {
      const nSessions = Math.max(...s.pipelines.map(scaled));
      await c.query(
        `INSERT INTO participant (study_id, participant_id, site)
         SELECT $1, 'P' || lpad(g::text, 7, '0'), 'site-' || ((g % 12) + 1) FROM generate_series(1, $2) g`,
        [s.id, nSessions],
      );
      await c.query(
        `INSERT INTO session (session_id, study_id, participant_id, visit)
         SELECT $1 || '/P' || lpad(g::text, 7, '0') || '/ses-1', $1, 'P' || lpad(g::text, 7, '0'), 'ses-1'
           FROM generate_series(1, $2) g`,
        [s.id, nSessions],
      );
      for (const p of s.pipelines) {
        // Lay units out over sessions in contiguous segments: [step, state, count]
        const E = scaled(p);
        const d = seedDistribution(p.steps, E, s.sim, rand);
        const last = p.steps[p.steps.length - 1].key;
        const segments: [string | null, string, number][] = [[last, 'released', d.released], [null, 'expected', d.notReceived]];
        p.steps.forEach((st, i) => {
          segments.push([st.key, 'queued', d.steps[i].queued], [st.key, 'running', d.steps[i].running], [st.key, 'failed', d.steps[i].failed]);
        });
        let offset = 0;
        for (const [stepKey, state, n] of segments) {
          if (n <= 0) continue;
          await c.query(
            `INSERT INTO work_unit (session_id, pipeline_id, step_key, state, attempts)
             SELECT session_id, $1, $2, $3, CASE WHEN $3 = 'failed' THEN 9 ELSE 0 END
               FROM session WHERE study_id = $4 ORDER BY session_id OFFSET $5 LIMIT $6`,
            [p.id, stepKey, state, s.id, offset, n],
          );
          offset += n;
        }
        // Units seeded as "running" have no run behind them; put them back in the queue so the scheduler picks them up.
        await c.query(`UPDATE work_unit SET state = 'queued' WHERE pipeline_id = $1 AND state = 'running'`, [p.id]);

        // Open review batches, backdated so some are near or past their SLA
        for (const st of p.steps.filter((x) => x.mode === 'manual')) {
          const batches = s.sim.activity >= 3 ? 1 + Math.floor(rand() * 3) : Math.floor(rand() * 2);
          const people = candidatesFor(cfg, s.id, st.role!);
          for (let b = 0; b < batches; b++) {
            const r = rand();
            const assignee = r < 0.3 ? null : r < 0.45 ? 'You' : people[Math.floor(rand() * people.length)];
            const ageDays = rand() * (st.slaDays ?? 7) * 1.8;
            const size = Math.max(5, Math.round(p.scheduler.qcBatchSize * scale * 4 * (0.4 + rand())));
            await createTask(c, p.id, st.key, size, assignee, new Date(Date.now() - ageDays * 864e5));
          }
        }
      }
    });
    console.log(`${s.id.padEnd(6)} seeded in ${Date.now() - t0} ms`);
  }

  const plan = await tx((c) => loadPlanFile(c));
  console.log(`Plan: ${plan.deliverables} deliverables, ${plan.items} items, ${plan.workflows} workflows.`);
  // Record initial deliverable states; the scheduler takes it from here.
  await tx((c) => reconcile(c, { launch: false }));
  const n = await pool.query('SELECT count(*)::int AS n FROM work_unit');
  console.log(`Done: ${n.rows[0].n.toLocaleString('en-US')} work units at scale ${scale}.`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
