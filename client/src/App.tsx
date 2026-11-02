import { useEffect, useState, useSyncExternalStore } from 'react';
import type { TrackerSource } from './data/source';
import { dueState } from './lib/format';
import { OverviewView } from './components/Overview';
import { WorkQueueView } from './components/WorkQueue';
import { EventLogView } from './components/EventLog';
import { SpecView } from './components/SpecView';
import { DeliverablesView } from './components/Deliverables';
import { WorkflowsView } from './components/Workflows';
import { itemOverdue } from './lib/format';
import { PathsView } from './components/Paths';
import { SubjectsView } from './components/Subjects';
import { isPersonTask } from './components/WorkQueue';

const VIEWS = [
  ['overview', 'Pipelines'],
  ['subjects', 'Subjects'],
  ['paths', 'Paths'],
  ['deliverables', 'Deliverables'],
  ['queue', 'Tasks'],
  ['workflows', 'Scripts'],
  ['log', 'Event log'],
  ['spec', 'Config'],
] as const;
type View = (typeof VIEWS)[number][0];

const readView = (): View => {
  const h = window.location.hash.slice(1);
  return (VIEWS.find(([v]) => v === h)?.[0] ?? 'overview') as View;
};

const ME_KEY = 'cohort-tracker:me';
const loadMe = () => { try { return localStorage.getItem(ME_KEY) ?? 'You'; } catch { return 'You'; } };
const saveMe = (v: string) => { try { localStorage.setItem(ME_KEY, v); } catch { /* storage unavailable */ } };

export function App({ source }: { source: TrackerSource }) {
  const { snapshot, status, paused, error } = useSyncExternalStore(source.subscribe, source.getState);
  const [view, setView] = useState<View>(readView);
  const [selected, setSelected] = useState('abcd-dmri');
  const [selectedDeliverable, setSelectedDeliverable] = useState('abcd-release-6');
  const [me, setMe] = useState(loadMe);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const onHash = () => setView(readView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Keep ages and overdue flags current, and in step with each new snapshot
  useEffect(() => { setNow(Date.now()); }, [snapshot]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);

  const run = (p: Promise<void>) => p.then(() => setNotice(null)).catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)));
  const tryRun = (p: Promise<void>) => p.then(() => { setNotice(null); return true; })
    .catch((e: unknown) => { setNotice(e instanceof Error ? e.message : String(e)); return false; });

  const overdue = snapshot
    ? snapshot.tasks.filter((t) => dueState(t, now) === 'overdue').length
      + snapshot.deliverables.flatMap((d) => d.items.filter((i) => isPersonTask(i, snapshot) && i.status !== 'done' && i.status !== 'skipped'
        && itemOverdue(i.dueDate ?? d.dueDate, now))).length
    : 0;
  const lateDeliverables = snapshot ? snapshot.deliverables.filter((d) => d.risk !== 'ok').length : 0;
  const openDeliverable = (id: string) => { setSelectedDeliverable(id); window.location.hash = 'deliverables'; };
  const statusLabel = paused ? 'Paused' : status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline';

  return (
    <div className="wrap">
      <header>
        <div className="brand">
          <h1>Cohort Data Tracker</h1>
          <div className="controls">
            {source.mode === 'mock' && <span className="chip warn">Simulated data</span>}
            <span className="muted small">{snapshot ? `${snapshot.studies.length} studies · ${snapshot.deliverables.length} deliverables · import → release` : 'Loading…'}</span>
          </div>
        </div>
        <div className="controls">
          <label className="acting">
            <span className="label">Acting as</span>
            <select id="acting-as" value={me} onChange={(e) => { setMe(e.target.value); saveMe(e.target.value); }}>
              {(snapshot?.people ?? [{ name: 'You' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
          <span className={`chip status-${paused ? 'paused' : status}`}><span className="live-dot" />{statusLabel}</span>
          <button className="btn" type="button" onClick={() => source.setPaused(!paused)}>{paused ? 'Resume feed' : 'Pause feed'}</button>
        </div>
      </header>

      <nav className="tabs" aria-label="Views">
        {VIEWS.map(([v, label]) => (
          <a key={v} href={`#${v}`} aria-current={view === v ? 'page' : undefined}>
            {label}
            {v === 'queue' && overdue > 0 && <span className="count">{overdue}</span>}
            {v === 'deliverables' && lateDeliverables > 0 && <span className="count">{lateDeliverables}</span>}
          </a>
        ))}
      </nav>

      {(notice || (error && status === 'error')) && (
        <div className="notice" role="status">
          <span>{notice ?? error}</span>
          {notice && <button className="btn sm" type="button" onClick={() => setNotice(null)}>Dismiss</button>}
        </div>
      )}

      {!snapshot && view !== 'spec' && <div className="panel empty">Waiting for the first snapshot from the tracker server…</div>}

      {snapshot && view === 'overview' && (
        <OverviewView
          snapshot={snapshot} now={now} selected={selected} onSelect={setSelected}
          onRetry={(pid, step) => run(source.retryFailed(pid, step, me))}
        />
      )}
      {snapshot && view === 'queue' && (
        <WorkQueueView
          snapshot={snapshot} now={now} me={me}
          onAssign={(id, who) => run(source.assignTask(id, who, me))}
          onComplete={(id) => run(source.completeTask(id, me))}
          onItem={(id, patch) => run(source.updateItem(id, patch, me))}
          onOpenDeliverable={openDeliverable}
        />
      )}
      {snapshot && view === 'deliverables' && (
        <DeliverablesView
          snapshot={snapshot} me={me} selected={selectedDeliverable} onSelect={setSelectedDeliverable}
          actions={{
            updateItem: (id, patch) => run(source.updateItem(id, patch, me)),
            runItem: (id) => run(source.runItem(id, me)),
          }}
        />
      )}
      {snapshot && view === 'workflows' && <WorkflowsView snapshot={snapshot} now={now} />}
      {snapshot && view === 'subjects' && <SubjectsView snapshot={snapshot} fetchUnits={source.fetchUnits} />}
      {snapshot && view === 'paths' && (
        <PathsView snapshot={snapshot} now={now} actions={{
          add: (e) => tryRun(source.addLocation(e, me)),
          update: (id, p) => tryRun(source.updateLocation(id, p, me)),
          remove: (id) => tryRun(source.deleteLocation(id, me)),
        }} />
      )}
      {snapshot && view === 'log' && <EventLogView snapshot={snapshot} />}
      {view === 'spec' && <SpecView />}
    </div>
  );
}
