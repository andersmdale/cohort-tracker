import { useState } from 'react';
import { MODALITY_LABEL, ROLE_LABEL } from '../../../shared/catalog';
import type { ItemPatch, Snapshot } from '../../../shared/types';
import { ageDays, dueState, fmt, fmtDate, itemOverdue, sum } from '../lib/format';
import { Segmented } from './Segmented';

type Filter = 'all' | 'mine' | 'unassigned' | 'overdue';

export function WorkQueueView({ snapshot, now, me, onAssign, onComplete, onItem, onOpenDeliverable }: {
  snapshot: Snapshot; now: number; me: string;
  onAssign: (taskId: number, assignee: string | null) => void;
  onComplete: (taskId: number) => void;
  onItem: (itemId: string, patch: ItemPatch) => void;
  onOpenDeliverable: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [study, setStudy] = useState('all');

  let tasks = snapshot.tasks;
  if (study !== 'all') tasks = tasks.filter((t) => t.study === study);
  if (filter === 'mine') tasks = tasks.filter((t) => t.assignee === me);
  if (filter === 'unassigned') tasks = tasks.filter((t) => !t.assignee);
  if (filter === 'overdue') tasks = tasks.filter((t) => dueState(t, now) === 'overdue');
  tasks = [...tasks].sort((a, b) => ageDays(b, now) / b.slaDays - ageDays(a, now) / a.slaDays);

  // Manual deliverable items: what people can act on now, plus (for "Mine") what is coming up
  const rows = snapshot.deliverables.flatMap((d) => d.items
    .filter((i) => i.mode === 'manual' && i.status !== 'done' && i.status !== 'skipped')
    .map((i) => ({ d, i, due: i.dueDate ?? d.dueDate })));
  let items = rows.filter(({ i }) => i.status === 'ready' || i.status === 'in_progress' || filter === 'mine');
  if (study !== 'all') items = items.filter(({ d }) => d.study === study);
  if (filter === 'mine') items = items.filter(({ i }) => i.assignee === me);
  if (filter === 'unassigned') items = items.filter(({ i }) => !i.assignee);
  if (filter === 'overdue') items = items.filter(({ due }) => itemOverdue(due, now));
  const rank = { in_progress: 0, ready: 1, failed: 2, blocked: 3 } as Record<string, number>;
  items.sort((a, b) => (rank[a.i.status] ?? 9) - (rank[b.i.status] ?? 9) || (a.due ?? '9').localeCompare(b.due ?? '9'));

  return (
    <div className="stack">
      <div className="filters">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[['all', 'All open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['overdue', 'Overdue']]}
        />
        <select id="queue-study" aria-label="Filter by study" value={study} onChange={(e) => setStudy(e.target.value)}>
          <option value="all">All studies</option>
          {snapshot.studies.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
        </select>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Deliverable tasks</h2>
          <span className="label">{filter === 'mine' ? 'Assigned to you, including blocked' : 'Ready or in progress'}</span>
        </div>
        <div className="tasks">
          {items.length === 0 && <div className="empty">No deliverable tasks match this filter.</div>}
          {items.map(({ d, i, due }) => {
            const late = itemOverdue(due, now);
            return (
              <div className={`task ${late ? 'overdue' : i.status === 'blocked' ? 'blocked' : ''}`} key={i.id}>
                <span className="sev" />
                <div className="what">
                  <b>{i.title}</b> · <button type="button" className="linkish" onClick={() => onOpenDeliverable(d.id)}>{d.title}</button>
                  <div>{i.status === 'blocked' ? i.blockedBy.join(' · ') : `Owner ${d.owner}${d.study ? ` · ${d.study}` : ''}`}</div>
                </div>
                <div className="age">
                  <span className={`chip ${late ? 'crit' : i.status === 'in_progress' ? 'run' : i.status === 'ready' ? 'accent' : ''}`}>
                    {i.status.replace('_', ' ')}{due ? ` · due ${fmtDate(due, true)}` : ''}
                  </span>
                </div>
                <div className="who">
                  <select id={`queue-item-${i.id}`} aria-label={`Assignee for ${i.title}`} value={i.assignee ?? ''}
                    onChange={(e) => onItem(i.id, { assignee: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {snapshot.people.map((p) => <option key={p.name} value={p.name}>{p.name} · {ROLE_LABEL[p.role]}</option>)}
                  </select>
                </div>
                <div className="act">
                  {!i.assignee && <button className="btn sm" type="button" onClick={() => onItem(i.id, { assignee: me })}>Take</button>}
                  {i.status === 'ready' && <button className="btn sm" type="button" onClick={() => onItem(i.id, { status: 'in_progress' })}>Start</button>}
                  {(i.status === 'ready' || i.status === 'in_progress') && <button className="btn sm primary" type="button" onClick={() => onItem(i.id, { status: 'done' })}>Mark done</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Review batches</h2>
          <span className="label">Auto-created and assigned to the least-loaded reviewer on each study's team</span>
        </div>
        <div className="tasks">
          {tasks.length === 0 && <div className="empty">No batches match this filter.</div>}
          {tasks.map((t) => {
            const st = dueState(t, now);
            const a = ageDays(t, now);
            return (
              <div className={`task ${st}`} key={t.id}>
                <span className="sev" />
                <div className="what">
                  <b>{t.label}</b> · {t.study} {MODALITY_LABEL[t.modality]} <span className="muted mono">#{t.id}</span>
                  <div>{fmt(t.n)} units at “{t.stepName}” · needs a {ROLE_LABEL[t.role].toLowerCase()}</div>
                </div>
                <div className="age">
                  <span className={`chip ${st === 'overdue' ? 'crit' : st === 'due' ? 'warn' : ''}`}>
                    {a < 1 ? '<1' : Math.floor(a)}d / SLA {t.slaDays}d
                  </span>
                </div>
                <div className="who">
                  <select
                    id={`assign-${t.id}`}
                    aria-label={`Assignee for batch ${t.id}`}
                    value={t.assignee ?? ''}
                    onChange={(e) => onAssign(t.id, e.target.value || null)}
                  >
                    <option value="">Unassigned</option>
                    {snapshot.people.map((p) => (
                      <option key={p.name} value={p.name}>{p.name} · {ROLE_LABEL[p.role]}</option>
                    ))}
                  </select>
                </div>
                <div className="act">
                  {!t.assignee && <button className="btn sm" type="button" onClick={() => onAssign(t.id, me)}>Claim</button>}
                  <button className="btn sm primary" type="button" onClick={() => onComplete(t.id)}>Pass batch</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <TeamLoad snapshot={snapshot} now={now} />
    </div>
  );
}

function TeamLoad({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const openItems = snapshot.deliverables.flatMap((d) => d.items
    .filter((i) => i.mode === 'manual' && i.status !== 'done' && i.status !== 'skipped')
    .map((i) => ({ i, due: i.dueDate ?? d.dueDate })));
  const owned = (name: string) => snapshot.deliverables.filter((d) => d.owner === name && d.state !== 'done').length;
  const rows = [
    ...snapshot.people.map((p) => ({ name: p.name, role: ROLE_LABEL[p.role], tasks: snapshot.tasks.filter((t) => t.assignee === p.name),
      items: openItems.filter((x) => x.i.assignee === p.name), owns: owned(p.name) })),
    { name: 'Unassigned', role: 'Any role', tasks: snapshot.tasks.filter((t) => !t.assignee), items: openItems.filter((x) => !x.i.assignee), owns: 0 },
  ];
  return (
    <div className="panel">
      <div className="panel-head"><h2>Team load</h2><span className="label">Review batches (units) · deliverable tasks · owns · overdue</span></div>
      <div className="people">
        {rows.map((r) => {
          const od = r.tasks.filter((t) => dueState(t, now) === 'overdue').length + r.items.filter((x) => itemOverdue(x.due, now)).length;
          return (
            <div className="person" key={r.name}>
              <b>{r.name}</b>
              <span className="muted">{r.role}</span>
              <span className="mono">
                {r.tasks.length} ({fmt(sum(r.tasks.map((t) => t.n)))}) · {r.items.length} · {r.owns} · <span className={od ? 'crit-t' : ''}>{od}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
