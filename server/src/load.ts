// Apply edits to the YAML files on a live database.
//   npm run config:load              # shared/studies.yaml: names, engines, commands, outputs, SLAs, launch, settings, teams, new paths
//   npm run config:load -- --paths   # also overwrite path inventory entries edited on the dashboard
//   npm run plan:load                # shared/plan.yaml: deliverables, dependencies, owners, items, workflows
//   npm run plan:load -- --prune     # also delete deliverables, items and workflows no longer in the file
import { pool, tx } from './db';
import { readConfig, updateFromConfig } from './config';
import { loadPlanFile } from './plan';
import { reconcile } from './scheduler';

const what = process.argv[2];
const prune = process.argv.includes('--prune');

async function main() {
  if (what === 'config') {
    const cfg = readConfig();
    const overwritePaths = process.argv.includes('--paths');
    const r = await tx((c) => updateFromConfig(c, cfg, { overwritePaths }));
    console.log(`Updated ${r.pipelines} pipelines across ${cfg.studies.length} studies from studies.yaml; ` +
      (overwritePaths ? `path inventory overwritten (${r.locations} entries).` : `${r.locations} new path entries added (edited entries kept; use --paths to overwrite).`));
  } else if (what === 'plan') {
    const r = await tx((c) => loadPlanFile(c, { prune }));
    console.log(`Loaded ${r.deliverables} deliverables, ${r.items} items, ${r.workflows} workflows from plan.yaml${prune ? `; pruned ${r.pruned}` : ''}.`);
  } else {
    throw new Error('Usage: tsx src/load.ts config|plan [--prune]');
  }
  // Let the scheduler act on the new definitions straight away
  await tx((c) => reconcile(c));
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => pool.end());
