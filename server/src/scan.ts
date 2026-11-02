// Check which step outputs exist on disk and move units (and deliverable items) forward to match.
// Run it on the machine that holds the data, e.g. nightly from cron, or after a batch finishes.
//
//   npm run scan                                  # every study whose host is "local"
//   npm run scan -- --study ABCD --modality dmri  # narrower
//   npm run scan -- --host TSD                    # when running inside an enclave with its own paths
//   npm run scan -- --dry-run                     # report only
//
// A unit is past a step when the step's output path exists (manual steps such as QC have no path
// and are passed only by a recorded decision). Units are only moved forward; nothing is deleted.
// Deliverable items whose output path exists are marked done.
import { pool, tx } from './db';
import { logEvent } from './services';
import { exists, studyContext, unitPath } from './paths';
import { pipelineDefs, type PipelineDef } from './units';
import { currentPlan } from './plan';
import { reconcile } from './scheduler';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const study = arg('--study');
const modality = arg('--modality');
const host = arg('--host') ?? 'local';
const dryRun = process.argv.includes('--dry-run');

async function scanPipeline(p: PipelineDef) {
  const c = await studyContext(pool, p.study);
  const units = await pool.query<{ unit_id: string; step_key: string | null; state: string; subject: string; visit: string; paths: Record<string, string> }>(
    `SELECT w.unit_id, w.step_key, w.state, w.paths, s.participant_id AS subject, s.visit
       FROM work_unit w JOIN session s USING (session_id)
      WHERE w.pipeline_id = $1 AND w.state NOT IN ('released', 'excluded')`, [p.id]);
  const n = p.steps.length;
  const moves = new Map<string, number[]>(); // "stepKey|state" -> unit ids
  const passedCount = new Map<string, number>();
  for (const u of units.rows) {
    const cur = u.state === 'expected' ? -1 : p.steps.findIndex((s) => s.key === u.step_key);
    let pos = 0;
    while (pos < n) {
      const st = p.steps[pos];
      if (st.output) {
        const path = u.paths[st.key] ?? unitPath(st.output, c.locations, { study: p.study, modality: p.modality, release: c.release, subject: u.subject, visit: u.visit });
        if (!exists(path)) break;
      } else if (pos >= cur) break; // manual step not yet decided
      pos++;
    }
    if (pos <= cur) continue; // forward only
    for (let i = Math.max(cur, 0); i < pos; i++) passedCount.set(p.steps[i].key, (passedCount.get(p.steps[i].key) ?? 0) + 1);
    const key = pos >= n ? `${p.steps[n - 1].key}|released` : `${p.steps[pos].key}|queued`;
    moves.set(key, [...(moves.get(key) ?? []), Number(u.unit_id)]);
  }
  const moved = [...moves.values()].reduce((a, x) => a + x.length, 0);
  if (dryRun || !moved) return { checked: units.rowCount ?? 0, moved };
  await tx(async (db) => {
    for (const [key, ids] of moves) {
      const [stepKey, state] = key.split('|');
      await db.query(`UPDATE work_unit SET step_key = $2, state = $3, attempts = 0, updated_at = now() WHERE unit_id = ANY($1)`, [ids, stepKey, state]);
    }
    for (const [stepKey, cnt] of passedCount) {
      const name = p.steps.find((s) => s.key === stepKey)?.name ?? stepKey;
      await logEvent(db, {
        pipelineId: p.id, stepKey, unitIds: [], kind: 'done', actor: 'scan', actorKind: 'system',
        note: `${name}: ${cnt.toLocaleString('en-US')} subject-visits found complete on disk`,
      }, cnt);
    }
  });
  return { checked: units.rowCount ?? 0, moved };
}

async function scanItems() {
  const plan = await currentPlan(pool);
  const hosts = new Map((await pool.query<{ study_id: string; host: string }>('SELECT study_id, host FROM study')).rows.map((r) => [r.study_id, r.host]));
  let done = 0;
  for (const d of plan.deliverables) {
    if (study && d.study !== study) continue;
    if ((d.study ? hosts.get(d.study) : 'local') !== host) continue;
    for (const it of d.items) {
      if (!it.outputPath || it.status === 'done' || it.status === 'skipped' || it.status === 'blocked') continue;
      if (!exists(it.outputPath)) continue;
      done++;
      if (dryRun) { console.log(`  item ${it.id}: output found at ${it.outputPath}`); continue; }
      await tx(async (db) => {
        await db.query(`UPDATE work_item SET status = 'done', updated_at = now() WHERE item_id = $1`, [it.id]);
        await logEvent(db, {
          pipelineId: null, stepKey: null, unitIds: [], kind: 'item', actor: 'scan', actorKind: 'system',
          deliverableId: d.id, itemId: it.id, note: `“${it.title}” output found at ${it.outputPath}`,
        });
      });
    }
  }
  return done;
}

async function main() {
  const studies = (await pool.query<{ study_id: string }>('SELECT study_id FROM study WHERE host = $1', [host])).rows.map((r) => r.study_id);
  const defs = (await pipelineDefs(pool, { study, modality })).filter((p) => studies.includes(p.study));
  if (!defs.length) console.log(`No pipelines on host "${host}"${study ? ` for ${study}` : ''}.`);
  for (const p of defs) {
    const r = await scanPipeline(p);
    console.log(`  ${p.id}: ${r.checked} checked, ${r.moved} moved forward${dryRun ? ' (dry run)' : ''}`);
  }
  const items = await scanItems();
  console.log(`  deliverable items with output on disk: ${items}${dryRun ? ' (dry run)' : ''}`);
  if (!dryRun) await tx((c) => reconcile(c));
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
