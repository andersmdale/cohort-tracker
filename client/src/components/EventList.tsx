import { MODALITY_LABEL } from '../../../shared/catalog';
import type { EventKind, TrackerEvent } from '../../../shared/types';
import { clock } from '../lib/format';

const KIND: Record<EventKind, [string, string]> = {
  arrive: ['received', 'ok'],
  start: ['started', 'run'],
  done: ['completed', 'ok'],
  fail: ['failed', 'crit'],
  decision: ['decision', 'warn'],
  assign: ['assigned', 'warn'],
  task: ['new batch', 'warn'],
  retry: ['requeued', 'run'],
  item: ['item', 'warn'],
  run: ['workflow', 'run'],
  deliverable: ['deliverable', 'ok'],
  location: ['path edit', 'accent'],
};

export function EventList({ events }: { events: TrackerEvent[] }) {
  if (!events.length) return <p className="empty">No events yet.</p>;
  return (
    <ul className="events">
      {events.map((e) => {
        const [label, tone] = KIND[e.kind];
        return (
          <li key={e.id}>
            <span className="t">{clock(e.at)}</span>
            <span><span className={`chip ${tone}`}>{label}</span></span>
            <span className="txt">
              {e.study && <b>{e.study} </b>}{e.modality ? `${MODALITY_LABEL[e.modality]} · ` : e.study ? '· ' : ''}{e.text}{' '}
              <span className="who">— {e.actor}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
