// Reference worker: claims runs from the tracker, executes their command, reports the outcome.
// Run one per execution environment (a SLURM login node, a Nextflow host, the TSD gateway, ...).
//
//   npm run worker -- --engines "slurm,nextflow:*" --name hpc-login-1
//   npm run worker -- --engines python --dry-run          # print commands instead of running them
//
// Options
//   --server URL       tracker API (default http://localhost:4000)
//   --engines LIST     comma-separated engine names; a trailing * matches a prefix (default: all)
//   --name NAME        worker name recorded on each run (default: hostname)
//   --concurrency N    runs executed at the same time (default 2)
//   --dry-run          don't execute; report success after printing the command
//
// For processing runs the unit list is written to a file and exposed to the command as
// $TRACKER_UNITS_FILE (one session id per line), with $TRACKER_RUN_ID and $TRACKER_SERVER.
// A command that knows which units failed can write their session ids, one per line, to
// $TRACKER_FAILED_FILE; the rest of the batch is reported as completed.
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const server = arg('--server', process.env.TRACKER_SERVER ?? 'http://localhost:4000')!;
const engines = arg('--engines')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const name = arg('--name', `worker@${hostname()}`)!;
const concurrency = Number(arg('--concurrency', '2'));
const dryRun = process.argv.includes('--dry-run');

interface Claimed {
  runId: number; kind: 'deliverable' | 'processing'; engine: string; command: string;
  sessionIds?: string[]; unitIds?: number[];
}

async function post(p: string, body: unknown) {
  const r = await fetch(`${server}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

function execute(run: Claimed): Promise<{ code: number; tail: string; failedSessions: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), `run-${run.runId}-`));
  const unitsFile = path.join(dir, 'units.txt');
  const failedFile = path.join(dir, 'failed.txt');
  writeFileSync(unitsFile, (run.sessionIds ?? []).join('\n'));
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', run.command], {
      env: { ...process.env, TRACKER_RUN_ID: String(run.runId), TRACKER_SERVER: server,
        TRACKER_UNITS_FILE: unitsFile, TRACKER_FAILED_FILE: failedFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const keep = (b: Buffer) => { out = (out + b.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (code) => {
      const failedSessions = existsSync(failedFile)
        ? readFileSync(failedFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : [];
      rmSync(dir, { recursive: true, force: true });
      resolve({ code: code ?? 1, tail: out.trim().split('\n').slice(-5).join(' | '), failedSessions });
    });
  });
}

async function handle(run: Claimed) {
  console.log(`[${new Date().toISOString()}] run #${run.runId} (${run.engine}): ${run.command}`);
  if (dryRun) {
    await post(`/api/workflow-runs/${run.runId}/finish`, { worker: name, status: 'succeeded', message: 'dry run' });
    return;
  }
  const r = await execute(run);
  const failedIds = run.sessionIds && run.unitIds
    ? run.sessionIds.map((s, i) => (r.failedSessions.includes(s) ? run.unitIds![i] : null)).filter((x): x is number => x !== null)
    : [];
  await post(`/api/workflow-runs/${run.runId}/finish`, {
    worker: name,
    status: r.code === 0 ? 'succeeded' : 'failed',
    message: r.code === 0 ? (failedIds.length ? `${failedIds.length} units failed` : null) : `exit ${r.code}: ${r.tail}`,
    failed_unit_ids: failedIds,
    reason_code: r.code === 0 ? (failedIds.length ? 'PROCESSING_ERROR' : null) : 'EXIT_NONZERO',
  });
  console.log(`  run #${run.runId} ${r.code === 0 ? 'succeeded' : `failed (exit ${r.code})`}`);
}

let active = 0;
async function loop() {
  while (active < concurrency) {
    let run: Claimed | null;
    try {
      run = (await post('/api/workflow-runs/claim', { worker: name, engines })) as Claimed | null;
    } catch (e) {
      console.error('claim failed:', (e as Error).message);
      break;
    }
    if (!run) break;
    active++;
    handle(run).catch((e) => console.error(`run #${run!.runId}:`, e.message)).finally(() => { active--; });
  }
  setTimeout(loop, 2000);
}

console.log(`${name} polling ${server} for ${engines.length ? engines.join(', ') : 'all engines'}${dryRun ? ' (dry run)' : ''}`);
loop();
