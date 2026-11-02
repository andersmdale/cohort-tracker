import { useMemo } from 'react';
import { MODALITY_LABEL, ROLE_LABEL } from '../../../shared/catalog';
import type { Deliverable, DeliverableState, Raci, Snapshot, WorkItem } from '../../../shared/types';
import { fmtDate, pctLabel } from '../lib/format';

const STATE_LABEL: Record<DeliverableState, string> = {
  done: 'Done', in_progress: 'In progress', ready: 'Ready', blocked: 'Blocked',
};
const STATE_TONE: Record<DeliverableState, string> = { done: 'ok', in_progress: 'run', ready: 'accent', blocked: '' };
const KIND_LABEL: Record<Deliverable['kind'], string> = {
  data_release: 'Data release', derivative: 'Derivative', analysis: 'Analysis', report: 'Report', infrastructure: 'Infrastructure',
};
const RACI_LABEL: Record<Raci, string> = { A: 'Accountable', R: 'Responsible', C: 'Consulted', I: 'Informed' };

export interface DeliverableActions {
  updateItem: (itemId: string, patch: { assignee?: string | null; status?: 'todo' | 'in_progress' | 'done' | 'skipped' }) => void;
  runItem: (itemId: string) => void;
}

export function RiskChip({ d }: { d: Deliverable }) {
  if (d.risk === 'late') return <span className="chip crit">Late</span>;
  if (d.risk === 'at_risk') return <span className="chip warn">At risk</span>;
  return null;
}

// ---------- dependency graph ----------

const W = 228, H = 68, GX = 56, GY = 14, PAD = 8;

function DependencyGraph({ deliverables, selected, onSelect }: {
  deliverables: Deliverable[]; selected: string; onSelect: (id: string) => void;
}) {
  const layout = useMemo(() => {
    const byId = new Map(deliverables.map((d) => [d.id, d]));
    const layer = new Map<string, number>();
    const depth = (id: string): number => {
      if (layer.has(id)) return layer.get(id)!;
      const d = byId.get(id);
      const v = d && d.dependsOn.length ? 1 + Math.max(...d.dependsOn.map(depth)) : 0;
      layer.set(id, v);
      return v;
    };
    deliverables.forEach((d) => depth(d.id));
    const cols: Deliverable[][] = [];
    for (const d of deliverables) (cols[layer.get(d.id)!] ??= []).push(d);
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((col, c) => col.forEach((d, r) => pos.set(d.id, { x: PAD + c * (W + GX), y: PAD + r * (H + GY) })));
    const width = PAD * 2 + cols.length * (W + GX) - GX;
    const height = PAD * 2 + Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
    return { pos, width, height, byId };
  }, [deliverables]);

  const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  return (
    <div className="scroll">
      <svg className="dag" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img" aria-label="Deliverable dependency graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" className="arrowhead" />
          </marker>
        </defs>
        {deliverables.flatMap((d) => d.dependsOn.map((dep) => {
          const a = layout.pos.get(dep)!, b = layout.pos.get(d.id)!;
          const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2;
          const done = layout.byId.get(dep)?.state === 'done';
          return (
            <path key={`${dep}>${d.id}`} className={`edge${done ? ' met' : ''}`} markerEnd="url(#arrow)"
              d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`} />
          );
        }))}
        {deliverables.map((d) => {
          const p = layout.pos.get(d.id)!;
          const met = d.gates.filter((g) => g.met).length;
          return (
            <g key={d.id} transform={`translate(${p.x},${p.y})`} className={`node s-${d.state}${d.id === selected ? ' sel' : ''}`}
              role="button" tabIndex={0} aria-label={`${d.title}: ${STATE_LABEL[d.state]}`}
              onClick={() => onSelect(d.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(d.id); } }}>
              <title>{d.title}{d.blockedBy.length ? `\n${d.blockedBy.join('\n')}` : ''}</title>
              <rect className="box" width={W} height={H} rx="6" />
              <rect className="stripe" width="4" height={H} rx="2" />
              <text className="t1" x="14" y="21">{short(d.title, 30)}</text>
              <text className="t2" x="14" y="39">{short(`${d.study ?? 'Cross-study'} · ${d.owner}`, 34)}</text>
              <text className="t3" x="14" y="56">
                {d.done}/{d.total} items{d.gates.length ? ` · gates ${met}/${d.gates.length}` : ''}{d.dueDate ? ` · ${fmtDate(d.dueDate, true)}` : ''}
              </text>
              {d.risk !== 'ok' && <circle className={`risk ${d.risk}`} cx={W - 12} cy="12" r="5" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------- list ----------

function DeliverableList({ deliverables, selected, onSelect }: {
  deliverables: Deliverable[]; selected: string; onSelect: (id: string) => void;
}) {
  return (
    <div className="dlist">
      {deliverables.map((d) => (
        <button type="button" key={d.id} className="drow" aria-pressed={d.id === selected} onClick={() => onSelect(d.id)}>
          <span className="dtitle"><b>{d.title}</b><span className="muted">{d.study ?? 'Cross-study'} · {d.owner}</span></span>
          <span className="dprog">
            <span className="minibar"><i style={{ width: `${(d.done / Math.max(1, d.total)) * 100}%` }} /></span>
            <span className="mono small">{d.done}/{d.total}</span>
          </span>
          <span className="ddue mono small">{d.dueDate ? fmtDate(d.dueDate) : '—'}</span>
          <span className="dstate"><span className={`chip ${STATE_TONE[d.state]}`}>{STATE_LABEL[d.state]}</span><RiskChip d={d} /></span>
        </button>
      ))}
    </div>
  );
}

// ---------- detail ----------

function ItemRow({ it, snapshot, me, actions, parentBlocked }: {
  it: WorkItem; snapshot: Snapshot; me: string; actions: DeliverableActions; parentBlocked: boolean;
}) {
  const wf = it.workflowId ? snapshot.workflows.find((w) => w.id === it.workflowId) : null;
  const run = it.lastRun;
  const tone = it.status === 'done' ? 'ok' : it.status === 'failed' ? 'crit' : it.status === 'in_progress' ? 'run'
    : it.status === 'ready' ? 'accent' : '';
  const label = it.status === 'in_progress' && run && (run.status === 'queued' || run.status === 'running')
    ? (run.status === 'queued' ? 'Queued' : 'Running') : it.status.replace('_', ' ');
  return (
    <div className={`irow st-${it.status}`}>
      <span className="ord">{String(it.ordinal).padStart(2, '0')}</span>
      <div className="imain">
        <div className="ititle">
          <b>{it.title}</b>
          {it.mode === 'automated'
            ? <span className="tag auto" title={wf?.command}>{wf?.trigger === 'manual' ? 'workflow · run by hand' : 'workflow · auto'}</span>
            : <span className="tag">manual</span>}
        </div>
        <div className="isub">
          {it.mode === 'automated' && wf && <span>{wf.name} <span className="mono">({wf.engine})</span> · maintained by {wf.maintainer}</span>}
          {it.mode === 'automated' && run && <span className="mono"> · run #{run.id} {run.status}{run.worker ? ` on ${run.worker}` : ''}{run.message ? `: ${run.message}` : ''}</span>}
          {!parentBlocked && it.blockedBy.length > 0 && <span className="blocked-why">{it.blockedBy.join(' · ')}</span>}
        </div>
      </div>
      <div className="iwho">
        {it.mode === 'manual' ? (
          <select id={`item-assignee-${it.id}`} aria-label={`Assignee for ${it.title}`} value={it.assignee ?? ''}
            onChange={(e) => actions.updateItem(it.id, { assignee: e.target.value || null })}>
            <option value="">Unassigned</option>
            {snapshot.people.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        ) : <span className="muted small">{wf?.maintainer}</span>}
      </div>
      <div className="iact">
        <span className={`chip ${tone}`}>{label}</span>
        {it.mode === 'manual' && it.status === 'ready' && (
          <button className="btn sm" type="button" onClick={() => actions.updateItem(it.id, { status: 'in_progress', ...(it.assignee ? {} : { assignee: me }) })}>Start</button>
        )}
        {it.mode === 'manual' && (it.status === 'ready' || it.status === 'in_progress') && (
          <button className="btn sm primary" type="button" onClick={() => actions.updateItem(it.id, { status: 'done' })}>Mark done</button>
        )}
        {it.mode === 'automated' && it.status === 'failed' && (
          <button className="btn sm" type="button" onClick={() => actions.runItem(it.id)}>Retry</button>
        )}
        {it.mode === 'automated' && it.status === 'ready' && wf?.trigger === 'manual' && (
          <button className="btn sm primary" type="button" onClick={() => actions.runItem(it.id)}>Run</button>
        )}
      </div>
    </div>
  );
}

function DeliverableDetail({ d, snapshot, me, onSelect, actions }: {
  d: Deliverable; snapshot: Snapshot; me: string; onSelect: (id: string) => void; actions: DeliverableActions;
}) {
  const title = (id: string) => snapshot.deliverables.find((x) => x.id === id);
  const pipe = (id: string) => snapshot.pipelines.find((p) => p.id === id);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <span className="label">{KIND_LABEL[d.kind]} · {d.study ?? 'Cross-study'}</span>
          <h2 className="detail-title">{d.title}</h2>
        </div>
        <span className="controls"><span className={`chip ${STATE_TONE[d.state]}`}>{STATE_LABEL[d.state]}</span><RiskChip d={d} /></span>
      </div>
      {d.description && <p className="small muted">{d.description}</p>}
      <div className="endcaps">
        <div><span className="label">Owner</span><b className="plain">{d.owner}</b></div>
        <div><span className="label">Due</span><b>{d.dueDate ? fmtDate(d.dueDate) : '—'}</b></div>
        <div><span className="label">Items done</span><b>{d.done}/{d.total}</b></div>
      </div>

      {d.blockedBy.length > 0 && (
        <div className="blocked">
          <span className="label">Blocked by</span>
          <ul>{d.blockedBy.map((b) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}

      {(d.dependsOn.length > 0 || d.neededBy.length > 0) && (
        <div className="links">
          {d.dependsOn.length > 0 && (
            <div><span className="label">Depends on</span>
              <div className="chips">{d.dependsOn.map((id) => {
                const x = title(id);
                return <button key={id} type="button" className={`linkchip${x?.state === 'done' ? ' met' : ''}`} onClick={() => onSelect(id)}>{x?.state === 'done' ? '✓ ' : ''}{x?.title ?? id}</button>;
              })}</div>
            </div>
          )}
          {d.neededBy.length > 0 && (
            <div><span className="label">Needed by</span>
              <div className="chips">{d.neededBy.map((id) => <button key={id} type="button" className="linkchip" onClick={() => onSelect(id)}>{title(id)?.title ?? id}</button>)}</div>
            </div>
          )}
        </div>
      )}

      {d.gates.length > 0 && (
        <div className="gates">
          <span className="label">Pipeline gates</span>
          {d.gates.map((g) => {
            const p = pipe(g.pipelineId);
            return (
              <div className="gate" key={g.pipelineId}>
                <span className="gname">{p ? `${p.study} ${MODALITY_LABEL[p.modality]}` : g.pipelineId}</span>
                <span className="gbar" title={`${pctLabel(g.current * 100)} released; needs ${pctLabel(g.threshold * 100)}`}>
                  <i className={g.met ? 'met' : ''} style={{ width: `${Math.min(100, g.current * 100)}%` }} />
                  <b style={{ left: `${g.threshold * 100}%` }} />
                </span>
                <span className={`mono small ${g.met ? 'ok-t' : ''}`}>{pctLabel(g.current * 100)} / {pctLabel(g.threshold * 100)}</span>
              </div>
            );
          })}
        </div>
      )}

      <div className="raci">
        {(['A', 'R', 'C', 'I'] as Raci[]).map((r) => {
          const who = d.raci.filter((x) => x.role === r).map((x) => x.person);
          if (!who.length) return null;
          return <div key={r}><span className="raci-k" title={RACI_LABEL[r]}>{r}</span><span>{RACI_LABEL[r]}: {who.join(', ')}</span></div>;
        })}
      </div>

      <div className="items">
        <span className="label">Work items</span>
        {d.items.map((it) => <ItemRow key={it.id} it={it} snapshot={snapshot} me={me} actions={actions} parentBlocked={d.blockedBy.length > 0} />)}
      </div>
    </div>
  );
}

export function DeliverablesView({ snapshot, me, selected, onSelect, actions }: {
  snapshot: Snapshot; me: string; selected: string; onSelect: (id: string) => void; actions: DeliverableActions;
}) {
  const ds = snapshot.deliverables;
  const d = ds.find((x) => x.id === selected) ?? ds[0];
  const count = (s: DeliverableState) => ds.filter((x) => x.state === s).length;
  const runsActive = snapshot.runs.filter((r) => r.itemId && (r.status === 'queued' || r.status === 'running')).length;
  const kpis: [string, string | number, string, boolean?][] = [
    ['Deliverables', ds.length, `${count('done')} done`],
    ['In progress', count('in_progress'), `${count('ready')} ready to start`],
    ['Blocked', count('blocked'), 'waiting on dependencies'],
    ['At risk', ds.filter((x) => x.risk === 'at_risk').length, 'due within 3 weeks', ds.some((x) => x.risk === 'at_risk')],
    ['Late', ds.filter((x) => x.risk === 'late').length, 'past due date', ds.some((x) => x.risk === 'late')],
    ['Workflows running', runsActive, 'started automatically or by hand'],
  ];
  if (!d) return <div className="panel empty">No deliverables yet. Add them to shared/plan.yaml and run npm run plan:load.</div>;
  return (
    <div className="stack">
      <div className="kpis">
        {kpis.map(([l, v, s, alert]) => (
          <div className="kpi" key={l}><span className="label">{l}</span><span className={`v${alert ? ' crit' : ''}`}>{v}</span><span className="s">{s}</span></div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Dependencies</h2>
          <div className="legend">
            <span><i className="sw s-done" /> done</span><span><i className="sw s-in_progress" /> in progress</span>
            <span><i className="sw s-ready" /> ready</span><span><i className="sw s-blocked" /> blocked</span>
            <span><i className="dot late" /> late / at risk</span>
          </div>
        </div>
        <DependencyGraph deliverables={ds} selected={d.id} onSelect={onSelect} />
      </div>
      <div className="grid2">
        <div className="panel">
          <div className="panel-head"><h2>All deliverables</h2><span className="label">Owner · progress · due</span></div>
          <DeliverableList deliverables={ds} selected={d.id} onSelect={onSelect} />
          <p className="small muted">
            Defined in <span className="mono">shared/plan.yaml</span>. Owners: {[...new Set(ds.map((x) => x.owner))].join(', ')}.
            Team roles: {snapshot.people.map((p) => `${p.name} (${ROLE_LABEL[p.role].toLowerCase()})`).join(', ')}.
          </p>
        </div>
        <DeliverableDetail d={d} snapshot={snapshot} me={me} onSelect={onSelect} actions={actions} />
      </div>
    </div>
  );
}
