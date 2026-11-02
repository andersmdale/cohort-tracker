import { useState } from 'react';
import type { Snapshot } from '../../../shared/types';
import { EventList } from './EventList';
import { Segmented } from './Segmented';

type Kind = 'all' | 'people' | 'fail';

export function EventLogView({ snapshot }: { snapshot: Snapshot }) {
  const [study, setStudy] = useState('all');
  const [kind, setKind] = useState<Kind>('all');
  let es = snapshot.events;
  if (study !== 'all') es = es.filter((e) => e.study === study);
  if (kind === 'people') es = es.filter((e) => e.kind === 'decision' || e.kind === 'assign' || e.kind === 'retry');
  if (kind === 'fail') es = es.filter((e) => e.kind === 'fail');
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Event log</h2>
        <div className="filters">
          <select id="log-study" aria-label="Filter log by study" value={study} onChange={(e) => setStudy(e.target.value)}>
            <option value="all">All studies</option>
            {snapshot.studies.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <Segmented<Kind> value={kind} onChange={setKind} options={[['all', 'All'], ['people', 'People'], ['fail', 'Failures']]} />
        </div>
      </div>
      <p className="muted small">
        Append-only. Each row records the actor, software version, reason code and every unit it touched.
        Showing the latest {snapshot.events.length}.
      </p>
      <EventList events={es.slice(0, 150)} />
    </div>
  );
}
