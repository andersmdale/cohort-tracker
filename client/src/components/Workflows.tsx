import { MODALITY_LABEL } from '../../../shared/catalog';
import type { RunStatus, Snapshot, WorkflowRun } from '../../../shared/types';
import { ago } from '../lib/format';

const TONE: Record<RunStatus, string> = { queued: '', running: 'run', succeeded: 'ok', failed: 'crit', cancelled: '' };

function runTarget(r: WorkflowRun, snapshot: Snapshot) {
  if (r.itemId) {
    const d = snapshot.deliverables.find((x) => r.itemId!.startsWith(`${x.id}/`));
    const it = d?.items.find((i) => i.id === r.itemId);
    const wf = snapshot.workflows.find((w) => w.id === r.workflowId);
    return { what: wf?.name ?? r.workflowId, where: `${it?.title ?? r.itemId} · ${d?.title ?? ''}` };
  }
  const p = snapshot.pipelines.find((x) => x.id === r.pipelineId);
  const st = p?.steps.find((s) => s.key === r.stepKey);
  return {
    what: `${st?.name ?? r.stepKey} · ${r.n} units`,
    where: p ? `${p.study} ${MODALITY_LABEL[p.modality]} pipeline` : r.pipelineId ?? '',
  };
}

function RunList({ runs, snapshot, now }: { runs: WorkflowRun[]; snapshot: Snapshot; now: number }) {
  if (!runs.length) return <p className="empty">Nothing here right now.</p>;
  return (
    <div className="runs">
      {runs.map((r) => {
        const t = runTarget(r, snapshot);
        return (
          <div className="runrow" key={r.id}>
            <span className="mono small muted">#{r.id}</span>
            <span className="rmain"><b>{t.what}</b><span className="muted small">{t.where}</span></span>
            <span className="mono small muted">{r.engine}</span>
            <span className="mono small muted">{r.worker ?? `by ${r.triggeredBy}`}</span>
            <span className="rstate"><span className={`chip ${TONE[r.status]}`}>{r.status}</span><span className="mono small muted">{ago(r.finishedAt ?? r.startedAt ?? r.createdAt, now)}</span></span>
            {r.message && <span className="rmsg small">{r.message}</span>}
          </div>
        );
      })}
    </div>
  );
}

export function WorkflowsView({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const active = snapshot.runs.filter((r) => r.status === 'queued' || r.status === 'running');
  const deliverableActive = active.filter((r) => r.itemId);
  const processingActive = active.filter((r) => r.pipelineId);
  const finished = snapshot.runs.filter((r) => r.status !== 'queued' && r.status !== 'running');
  const external = snapshot.pipelines.flatMap((p) => p.steps.filter((s) => s.mode === 'auto' && s.launch === 'external').map((s) => `${p.study} ${MODALITY_LABEL[p.modality]} ${s.name}`));
  return (
    <div className="stack">
      <div className="panel prose">
        <h2>What starts automatically</h2>
        <p>
          The scheduler checks every few seconds. Units waiting at an automated pipeline step are batched into processing runs,
          up to each study's run limit. Units reaching a review step are batched and assigned to the least-loaded reviewer on that
          study's team. A deliverable's workflow items start as soon as its upstream deliverables are done, its pipeline gates are met
          and earlier items have finished. Workflows marked “run by hand” wait for someone to press Run. Workers pick up queued runs by engine.
        </p>
        {external.length > 0 && <p className="small muted">Run by the studies' own engines (reported, not launched): {external.slice(0, 8).join(', ')}{external.length > 8 ? `, and ${external.length - 8} more` : ''}.</p>}
      </div>
      <div className="stack">
        <div className="panel">
          <div className="panel-head"><h2>Deliverable workflows in flight</h2><span className="label">{deliverableActive.length} active</span></div>
          <RunList runs={deliverableActive} snapshot={snapshot} now={now} />
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Processing runs in flight</h2><span className="label">{processingActive.length} active</span></div>
          <RunList runs={processingActive.slice(0, 12)} snapshot={snapshot} now={now} />
          {processingActive.length > 12 && <p className="small muted">And {processingActive.length - 12} more queued or running.</p>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Workflow catalog</h2><span className="label">trigger · maintainer · last runs · success</span></div>
        <div className="scroll">
          <table className="wf">
            <thead><tr><th>Workflow</th><th>Engine</th><th>Trigger</th><th>Maintainer</th><th>Used by</th><th>Recent runs</th><th className="right">Success</th></tr></thead>
            <tbody>
              {snapshot.workflows.map((w) => (
                <tr key={w.id}>
                  <td><b>{w.name}</b><div className="mono small muted" title={w.command}>{w.id}</div></td>
                  <td className="mono small">{w.engine}</td>
                  <td><span className={`chip ${w.trigger === 'on_ready' ? 'accent' : 'warn'}`}>{w.trigger === 'on_ready' ? 'auto when ready' : 'run by hand'}</span></td>
                  <td>{w.maintainer}</td>
                  <td className="mono small">{w.usedBy.length} item{w.usedBy.length === 1 ? '' : 's'}</td>
                  <td><span className="dots">{w.recentRuns.slice(0, 8).reverse().map((r) => <i key={r.id} className={`d-${r.status}`} title={`#${r.id} ${r.status}`} />)}</span></td>
                  <td className="mono small right">{w.successRate === null ? '—' : `${Math.round(w.successRate * 100)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h2>Recently finished</h2><span className="label">latest {Math.min(20, finished.length)}</span></div>
        <RunList runs={finished.slice(0, 20)} snapshot={snapshot} now={now} />
      </div>
    </div>
  );
}
