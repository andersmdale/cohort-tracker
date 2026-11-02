// Register subject x visit data that already exists, so the tracker knows what each study has.
//
// From disk (run on the machine that holds the data):
//   npm run import -- --study ABCD                       # every modality of ABCD
//   npm run import -- --study ABCD --modality dmri       # one modality
//   Finds folders matching the first step's output template (e.g. {raw_root}/{subject}/{visit})
//   using the path inventory, and creates a unit per subject x visit.
//
// From a CSV (for data in enclaves such as TSD or HUNT Cloud, or any list you export):
//   npm run import -- --study TOP --modality smri --csv top_smri.csv
//   Columns: subject,visit[,completed_through]
//     completed_through = a step key (e.g. roi_extract) → the unit is past that step
//                         complete                      → all steps done
//                         expected                      → expected but not on disk yet
//                         empty                         → on disk, nothing processed
//
// Add --dry-run to see what would change. Existing units only move forward; nothing is deleted.
import { readFileSync } from 'node:fs';
import { pool, tx } from './db';
import { logEvent } from './services';
import { discover, studyContext } from './paths';
import { pipelineDefs, upsertUnits, type PipelineDef, type UnitPosition } from './units';
import { reconcile } from './scheduler';
import { renderPath } from '../../shared/catalog';
import { pathVars } from '../../shared/config';

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const study = arg('--study');
const modality = arg('--modality');
const csv = arg('--csv');
const dryRun = process.argv.includes('--dry-run');

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const split = (l: string) => l.split(',').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

/** Position right after `stepKey` (or at the first step when null). */
function after(p: PipelineDef, stepKey: string | null): Pick<UnitPosition, 'stepKey' | 'state'> {
  const i = stepKey === null ? -1 : p.steps.findIndex((s) => s.key === stepKey);
  const next = p.steps[i + 1];
  return next ? { stepKey: next.key, state: 'queued' } : { stepKey: p.steps[p.steps.length - 1].key, state: 'released' };
}

async function fromDisk(p: PipelineDef): Promise<UnitPosition[]> {
  const first = p.steps[0];
  if (!first.output) throw new Error(`${p.id}: the first step "${first.key}" has no output template to search`);
  const c = await studyContext(pool, p.study);
  const vars = pathVars(c.locations, { study: p.study, modality: p.modality, release: c.release });
  const template = renderPath(first.output, vars);
  if (!template.includes('{subject}')) {
    console.log(`  ${p.id}: "${first.output}" is one dataset, not per subject; skipped (use --csv)`);
    return [];
  }
  console.log(`  ${p.id}: searching ${template}`);
  const found = discover(template);
  const visits = new Set(c.visits);
  const unknown = new Set(found.filter((f) => f.visit && visits.size && !visits.has(f.visit)).map((f) => f.visit));
  if (unknown.size) console.log(`    note: visits not listed for ${p.study}: ${[...unknown].slice(0, 5).join(', ')}`);
  const pos = after(p, first.key);
  return found.map((f) => ({ subject: f.subject, visit: f.visit ?? c.visits[0], ...pos }));
}

function fromCsv(p: PipelineDef, rows: Record<string, string>[]): UnitPosition[] {
  const keys = new Set(p.steps.map((s) => s.key));
  return rows.map((r, i) => {
    if (!r.subject || !r.visit) throw new Error(`CSV row ${i + 2}: subject and visit are required`);
    const c = (r.completed_through ?? '').trim();
    if (c === 'expected') return { subject: r.subject, visit: r.visit, stepKey: null, state: 'expected' as const };
    if (c === 'complete') return { subject: r.subject, visit: r.visit, ...after(p, p.steps[p.steps.length - 1].key) };
    if (c === '') return { subject: r.subject, visit: r.visit, stepKey: p.steps[0].key, state: 'queued' as const };
    if (!keys.has(c)) throw new Error(`CSV row ${i + 2}: "${c}" is not a step of ${p.id} (${[...keys].join(', ')})`);
    return { subject: r.subject, visit: r.visit, ...after(p, c) };
  });
}

async function main() {
  if (!study) throw new Error('Usage: npm run import -- --study ABCD [--modality dmri] [--csv file.csv] [--dry-run]');
  const defs = await pipelineDefs(pool, { study, modality });
  if (!defs.length) throw new Error(`No pipelines for ${study}${modality ? ` ${modality}` : ''}`);
  if (csv && defs.length > 1) throw new Error('With --csv, also give --modality');
  const csvRows = csv ? parseCsv(readFileSync(csv, 'utf8')) : null;
  for (const p of defs) {
    const rows = csvRows ? fromCsv(p, csvRows) : await fromDisk(p);
    if (dryRun) { console.log(`  ${p.id}: ${rows.length} subject-visits found (dry run, nothing saved)`); continue; }
    const r = await tx(async (c) => {
      const res = await upsertUnits(c, p, rows);
      if (res.created || res.advanced) {
        await logEvent(c, {
          pipelineId: p.id, stepKey: p.steps[0].key, unitIds: [], kind: 'arrive', actor: csv ? 'import (csv)' : 'import (disk)',
          actorKind: 'system', note: `${res.created} subject-visits registered, ${res.advanced} moved forward`,
        }, res.created + res.advanced);
      }
      return res;
    });
    console.log(`  ${p.id}: ${rows.length} found, ${r.created} new, ${r.advanced} moved forward`);
  }
  if (!dryRun) await tx((c) => reconcile(c));
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
