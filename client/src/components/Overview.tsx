import { MODALITIES, MODALITY_LABEL } from '../../../shared/catalog';
import type { PipelineStatus, Snapshot } from '../../../shared/types';
import { dueState, failed, fmt, inFlight, pct, pctLabel, sum, waitingOnPeople } from '../lib/format';
import { EventList } from './EventList';

export function KpiStrip({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const P = snapshot.pipelines;
  const E = sum(P.map((p) => p.expected));
  const rel = sum(P.map((p) => p.released));
  const fl = sum(P.map(failed));
  const overdue = snapshot.tasks.filter((t) => dueState(t, now) === 'overdue').length;
  const kpis: { label: string; value: string; sub: string; alert?: boolean }[] = [
    { label: 'Units expected', value: fmt(E), sub: `${snapshot.studies.length} studies · ${P.length} pipelines` },
    { label: 'Released', value: pctLabel(pct(rel, E)), sub: `${fmt(rel)} units` },
    { label: 'In flight', value: fmt(sum(P.map(inFlight))), sub: `${fmt(sum(P.map((p) => p.notReceived)))} not yet received` },
    { label: 'Failed', value: fmt(fl), sub: 'awaiting retry', alert: fl > 0 },
    { label: 'Open batches', value: String(snapshot.tasks.length), sub: `${fmt(sum(snapshot.tasks.map((t) => t.n)))} units on people` },
    { label: 'Overdue', value: String(overdue), sub: 'past SLA', alert: overdue > 0 },
  ];
  return (
    <div className="kpis">
      {kpis.map((k) => (
        <div className="kpi" key={k.label}>
          <span className="label">{k.label}</span>
          <span className={`v${k.alert ? ' crit' : ''}`}>{k.value}</span>
          <span className="s">{k.sub}</span>
        </div>
      ))}
    </div>
  );
}

export function Heatmap({ snapshot, selected, onSelect }: {
  snapshot: Snapshot; selected: string; onSelect: (id: string) => void;
}) {
  const byKey = new Map(snapshot.pipelines.map((p) => [`${p.study}|${p.modality}`, p]));
  return (
    <div className="scroll">
      <table className="heat">
        <thead>
          <tr>
            <th />
            {MODALITIES.map((m) => <th key={m.key} scope="col">{m.label}</th>)}
            <th scope="col" className="right">All</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.studies.map((s) => {
            const ps = snapshot.pipelines.filter((p) => p.study === s.id);
            const all = pct(sum(ps.map((p) => p.released)), sum(ps.map((p) => p.expected)));
            return (
              <tr key={s.id}>
                <th className="row" scope="row">{s.id}<small>{s.name}</small></th>
                {MODALITIES.map((m) => {
                  const p = byKey.get(`${s.id}|${m.key}`);
                  if (!p) return <td key={m.key} className="na">·</td>;
                  const v = pct(p.released, p.expected);
                  const fl = failed(p);
                  const waiting = waitingOnPeople(p);
                  return (
                    <td key={m.key}>
                      <button
                        type="button"
                        className={`cell${v > 58 ? ' dark' : ''}`}
                        style={{ '--p': v.toFixed(1) } as React.CSSProperties}
                        aria-pressed={p.id === selected}
                        aria-label={`${s.id} ${m.label}: ${v.toFixed(1)}% released`}
                        onClick={() => onSelect(p.id)}
                      >
                        <span className="pct">{pctLabel(v)}</span>
                        <span className="flags">
                          {fl > 0 && <span className="f c">✕{fmt(fl)}</span>}
                          {waiting > p.expected * 0.01 && <span className="f w">◷{fmt(waiting)}</span>}
                        </span>
                      </button>
                    </td>
                  );
                })}
                <td className="overall">{pctLabel(all)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function PipelineDetail({ pipeline: p, onRetry }: {
  pipeline: PipelineStatus; onRetry: (stepKey: string) => void;
}) {
  const max = Math.max(1, ...p.steps.map((s) => s.queued + s.running + s.failed));
  const v = pct(p.released, p.expected);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <span className="label">{p.source} → {p.engine}@{p.version}</span>
          <h2 className="detail-title">{p.study} · {MODALITY_LABEL[p.modality]}</h2>
        </div>
        <span className={`chip ${v > 95 ? 'ok' : 'run'}`}>{pctLabel(v)} released</span>
      </div>
      <div className="endcaps">
        <div><span className="label">Expected</span><b>{fmt(p.expected)}</b></div>
        <div><span className="label">Not received</span><b>{fmt(p.notReceived)}</b></div>
        <div><span className="label">Released</span><b>{fmt(p.released)}</b></div>
      </div>
      <div className="steps">
        {p.steps.map((s) => (
          <div className="step" key={s.key}>
            <span className="ord">{String(s.ordinal).padStart(2, '0')}</span>
            <span className="nm">
              {s.name}
              {s.mode === 'manual' && <span className="tag">manual</span>}
              {s.mode === 'auto' && s.launch === 'external' && <span className="tag ext" title="Run by the study's own engine, which reports progress to the tracker">external</span>}
              {s.activeRuns > 0 && <span className="runs-t" title="Processing runs launched by the scheduler">{s.activeRuns}/{p.settings.maxActiveRuns} runs</span>}
            </span>
            <span className="cnt">
              {fmt(s.queued)}
              {s.running > 0 && <span className="run-t"> ▸{fmt(s.running)}</span>}
              {s.failed > 0 && <span className="crit-t"> ✕{fmt(s.failed)}</span>}
              {s.failed > 0 && <button className="btn sm" type="button" onClick={() => onRetry(s.key)}>Retry</button>}
            </span>
            <span className="bar">
              <i className="w" style={{ width: `${(s.queued / max) * 100}%` }} />
              <i className="r" style={{ width: `${(s.running / max) * 100}%` }} />
              <i className="x" style={{ width: `${(s.failed / max) * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="legend">
        <span>Units at each step, scaled to the largest step</span>
        <span><i className="sw w" /> queued</span>
        <span><i className="sw r" /> running</span>
        <span><i className="sw x" /> failed</span>
        {p.excluded > 0 && <span>{fmt(p.excluded)} excluded</span>}
      </div>
      <div className="settings-line">
        <span>Batch {p.settings.batchSize} units</span>
        <span>≤{p.settings.maxActiveRuns} runs per step</span>
        <span>{p.settings.autoRetry ? `Auto-retry ×${p.settings.autoRetry}` : 'No auto-retry'}</span>
        <span>Review batches of {p.settings.qcBatchSize}</span>
      </div>
    </div>
  );
}

export function OverviewView({ snapshot, now, selected, onSelect, onRetry }: {
  snapshot: Snapshot; now: number; selected: string;
  onSelect: (id: string) => void; onRetry: (pipelineId: string, stepKey: string) => void;
}) {
  const pipeline = snapshot.pipelines.find((p) => p.id === selected) ?? snapshot.pipelines[0];
  return (
    <div className="stack">
      <KpiStrip snapshot={snapshot} now={now} />
      <div className="grid2">
        <div className="panel">
          <div className="panel-head">
            <h2>Released, by study and modality</h2>
            <span className="label">Select a cell for its pipeline</span>
          </div>
          <Heatmap snapshot={snapshot} selected={pipeline?.id ?? ''} onSelect={onSelect} />
          <div className="legend">
            <span><span className="ramp" /> 0–100% of expected units released</span>
            <span><b className="crit-t mono">✕n</b> failed units</span>
            <span><b className="warn-t mono">◷n</b> waiting on a person</span>
          </div>
        </div>
        <div className="stack">
          {pipeline && <PipelineDetail pipeline={pipeline} onRetry={(k) => onRetry(pipeline.id, k)} />}
          <div className="panel">
            <div className="panel-head"><h2>Latest activity</h2><a href="#log" className="label link">Full log →</a></div>
            <EventList events={snapshot.events.slice(0, 7)} />
          </div>
        </div>
      </div>
    </div>
  );
}
