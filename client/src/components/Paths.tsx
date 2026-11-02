import { useMemo, useState } from 'react';
import { MODALITIES, MODALITY_LABEL, renderPath, type ModalityKey } from '../../../shared/catalog';
import { pathVars } from '../../../shared/config';
import type { DataLocation, Snapshot } from '../../../shared/types';
import type { LocationPatch } from '../data/source';
import { ago } from '../lib/format';
import { CopyButton } from './CopyButton';

export interface PathActions {
  add: (e: LocationPatch) => Promise<boolean>;
  update: (id: number, p: LocationPatch) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
}

const STANDARD = ['raw_root', 'mmps_root', 'fsurf_root', 'nq_root', 'roi_root', 'atlas_root', 'concat_root', 'svd_root', 'tables_root'];

function Row({ l, snapshot, now, actions, usedBy }: {
  l: DataLocation; snapshot: Snapshot; now: number; actions: PathActions; usedBy: number;
}) {
  const [path, setPath] = useState(l.path);
  const [host, setHost] = useState(l.host);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = path !== l.path || host !== l.host;
  const study = snapshot.studies.find((s) => s.id === l.study);
  const studyLocs = snapshot.locations.filter((x) => x.study === l.study).map((x) => (x.id === l.id ? { ...x, path } : x));
  const resolved = renderPath(path, pathVars(studyLocs, { study: l.study, modality: l.modality, release: study?.release }));
  const save = async () => { setBusy(true); await actions.update(l.id, { path, host }); setBusy(false); };
  return (
    <div className={`prow${dirty ? ' dirty' : ''}`}>
      <div className="pkey">
        <span className="mono">{l.key}</span>
        <span className="small muted">{l.modality ? MODALITY_LABEL[l.modality] : 'All modalities'}{usedBy ? ` · used by ${usedBy}` : ''}</span>
      </div>
      <div className="ppath">
        <input id={`loc-path-${l.id}`} aria-label={`Path for ${l.study} ${l.key}`} className="mono" value={path}
          onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && dirty) void save(); }} />
        {resolved !== path && <span className="resolved mono small" title="With other names and {release} filled in">→ {resolved}</span>}
      </div>
      <input id={`loc-host-${l.id}`} aria-label={`Host for ${l.study} ${l.key}`} className="phost" value={host} onChange={(e) => setHost(e.target.value)} />
      <span className="small muted pwho">{l.updatedBy ?? '—'} · {ago(l.updatedAt, now)}</span>
      <span className="pact">
        <CopyButton text={resolved} />
        {dirty && <>
          <button className="btn sm primary" type="button" disabled={busy} onClick={save}>Save</button>
          <button className="btn sm" type="button" onClick={() => { setPath(l.path); setHost(l.host); }}>Undo</button>
        </>}
        {!dirty && !confirm && <button className="btn sm" type="button" onClick={() => setConfirm(true)}>Remove</button>}
        {confirm && <>
          <span className="small crit-t">Remove?</span>
          <button className="btn sm danger" type="button" onClick={() => { setConfirm(false); void actions.remove(l.id); }}>Yes</button>
          <button className="btn sm" type="button" onClick={() => setConfirm(false)}>No</button>
        </>}
      </span>
    </div>
  );
}

function AddForm({ snapshot, study, actions }: { snapshot: Snapshot; study: string; actions: PathActions }) {
  const [s, setS] = useState(study === 'all' ? snapshot.studies[0]?.id ?? '' : study);
  const [modality, setModality] = useState('');
  const [key, setKey] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await actions.add({ study: s, modality: modality || null, key: key.trim(), path: path.trim(), description: description.trim() || null })) {
      setKey(''); setPath(''); setDescription('');
    }
  };
  return (
    <form className="addform" onSubmit={submit}>
      <select id="add-loc-study" aria-label="Study" value={s} onChange={(e) => setS(e.target.value)}>
        {snapshot.studies.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}
      </select>
      <select id="add-loc-modality" aria-label="Modality" value={modality} onChange={(e) => setModality(e.target.value)}>
        <option value="">All modalities</option>
        {MODALITIES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
      </select>
      <input id="add-loc-key" aria-label="Name" className="mono" placeholder="name, e.g. mmps_root" list="loc-keys" value={key} onChange={(e) => setKey(e.target.value)} />
      <datalist id="loc-keys">{STANDARD.map((k) => <option key={k} value={k} />)}</datalist>
      <input id="add-loc-path" aria-label="Path" className="mono grow" placeholder="/path/to/data — may use {study} {release} and other names" value={path} onChange={(e) => setPath(e.target.value)} />
      <input id="add-loc-desc" aria-label="Description" placeholder="note (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
      <button className="btn primary" type="submit" disabled={!s || !key.trim() || !path.trim()}>Add path</button>
    </form>
  );
}

export function PathsView({ snapshot, now, actions }: { snapshot: Snapshot; now: number; actions: PathActions }) {
  const [study, setStudy] = useState(snapshot.studies[0]?.id ?? 'all');
  const [q, setQ] = useState('');
  const usedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of snapshot.locations) {
      const needle = `{${l.key}}`;
      const steps = snapshot.pipelines.filter((p) => p.study === l.study && (!l.modality || p.modality === l.modality))
        .flatMap((p) => p.steps).filter((s) => s.output?.includes(needle)).length;
      const items = snapshot.deliverables.filter((d) => d.study === l.study).flatMap((d) => d.items)
        .filter((i) => i.outputTemplate?.includes(needle)).length;
      const nested = snapshot.locations.filter((x) => x.study === l.study && x.id !== l.id && x.path.includes(needle)).length;
      m.set(String(l.id), steps + items + nested);
    }
    return m;
  }, [snapshot.locations, snapshot.pipelines, snapshot.deliverables]);
  const studies = snapshot.studies.filter((s) => study === 'all' || s.id === study);
  const match = (l: DataLocation) => !q || `${l.key} ${l.path} ${l.modality ?? ''}`.toLowerCase().includes(q.toLowerCase());
  return (
    <div className="stack">
      <div className="panel prose">
        <h2>Where each study's data lives</h2>
        <p>
          Every per-subject and per-release path in the tracker is built from these entries. A step's output template such as
          <span className="mono"> {'{mmps_root}'}/MRIPROC_{'{subject}'}_{'{visit}'}</span> uses the study's <span className="mono">mmps_root</span>;
          an entry for one modality overrides the study-wide one. Changes apply immediately and are recorded in the event log.
          The import and scan scripts read these paths on the machine where they run.
        </p>
      </div>
      <div className="panel">
        <div className="panel-head">
          <h2>Add a path</h2>
          <div className="filters">
            <select id="paths-study" aria-label="Show study" value={study} onChange={(e) => setStudy(e.target.value)}>
              <option value="all">All studies</option>
              {snapshot.studies.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
            </select>
            <input id="paths-search" aria-label="Filter paths" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <AddForm snapshot={snapshot} study={study} actions={actions} />
      </div>
      {studies.map((s) => {
        const locs = snapshot.locations.filter((l) => l.study === s.id && match(l))
          .sort((a, b) => (a.modality ?? '').localeCompare(b.modality ?? '') || STANDARD.indexOf(a.key) - STANDARD.indexOf(b.key) || a.key.localeCompare(b.key));
        if (!locs.length && q) return null;
        const mods = snapshot.pipelines.filter((p) => p.study === s.id).map((p) => MODALITY_LABEL[p.modality as ModalityKey]);
        return (
          <div className="panel" key={s.id}>
            <div className="panel-head">
              <div><h2>{s.id} <span className="muted small">{s.name}</span></h2>
                <span className="small muted">Host {s.host} · release {s.release || '—'} · visits {s.visits.join(', ')} · {mods.join(', ')}</span></div>
              <span className="label">{locs.length} paths</span>
            </div>
            <div className="ptable">
              {locs.map((l) => <Row key={`${l.id}:${l.updatedAt}`} l={l} snapshot={snapshot} now={now} actions={actions} usedBy={usedBy.get(String(l.id)) ?? 0} />)}
              {!locs.length && <div className="empty">No paths yet for {s.id}.</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
