import { useState } from 'react';
import { MODALITY_LABEL } from '../../../shared/catalog';
import type { Snapshot, UnitRow } from '../../../shared/types';
import { CopyButton } from './CopyButton';

const STATE_TONE: Record<string, string> = {
  released: 'ok', queued: 'accent', running: 'run', failed: 'crit', expected: '', excluded: 'warn',
};

export function SubjectsView({ snapshot, fetchUnits }: {
  snapshot: Snapshot;
  fetchUnits: (q: { study?: string; modality?: string; subject?: string }) => Promise<UnitRow[] | null>;
}) {
  const [study, setStudy] = useState(snapshot.studies[0]?.id ?? '');
  const [modality, setModality] = useState('');
  const [subject, setSubject] = useState('');
  const [rows, setRows] = useState<UnitRow[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const mods = snapshot.pipelines.filter((p) => !study || p.study === study).map((p) => p.modality);

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    try {
      setRows(await fetchUnits({ study: study || undefined, modality: modality || undefined, subject: subject.trim() || undefined }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stepName = (r: UnitRow) => r.paths.find((p) => p.stepKey === r.stepKey)?.stepName ?? r.stepKey ?? '—';
  const where = (r: UnitRow) => r.state === 'released' ? 'Complete' : r.state === 'expected' ? 'Not on disk yet' : r.state === 'excluded' ? 'Excluded' : `${stepName(r)} · ${r.state}`;

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head"><h2>Find subject data</h2><span className="label">Status and paths per subject × visit</span></div>
        <form className="addform" onSubmit={search}>
          <select id="subj-study" aria-label="Study" value={study} onChange={(e) => { setStudy(e.target.value); setModality(''); }}>
            <option value="">All studies</option>
            {snapshot.studies.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}
          </select>
          <select id="subj-modality" aria-label="Modality" value={modality} onChange={(e) => setModality(e.target.value)}>
            <option value="">All modalities</option>
            {[...new Set(mods)].map((m) => <option key={m} value={m}>{MODALITY_LABEL[m]}</option>)}
          </select>
          <input id="subj-id" aria-label="Subject id" className="mono grow" placeholder="Subject id or its beginning, e.g. NDARINV0" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <button className="btn primary" type="submit">Search</button>
        </form>
        {error && <div className="notice">{error}</div>}
        {rows === null && <p className="empty">The subject browser needs the tracker server; it isn't available with simulated data.</p>}
        {rows && rows.length === 0 && <p className="empty">No subject-visits match. Register data with <span className="mono">npm run import</span>.</p>}
        {rows && rows.length > 0 && (
          <div className="units">
            {rows.map((r) => (
              <div className="unit" key={r.unitId}>
                <button type="button" className="urow" aria-expanded={open === r.unitId} onClick={() => setOpen(open === r.unitId ? null : r.unitId)}>
                  <span className="mono">{r.subject}</span>
                  <span className="mono small muted">{r.visit}</span>
                  <span>{r.study} {MODALITY_LABEL[r.modality]}</span>
                  <span><span className={`chip ${STATE_TONE[r.state] ?? ''}`}>{where(r)}</span></span>
                  <span className="muted small">{r.paths.filter((p) => p.passed).length}/{r.paths.length} steps</span>
                </button>
                {open === r.unitId && (
                  <div className="usteps">
                    {r.paths.map((p) => (
                      <div className="ustep" key={p.stepKey}>
                        <span className={p.passed ? 'ok-t' : 'muted'}>{p.passed ? '✓' : '○'}</span>
                        <span>{p.stepName}</span>
                        <span className="mono small upath">{p.path ?? <span className="muted">recorded decision, no file</span>}</span>
                        {p.path ? <CopyButton text={p.path} /> : <span />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {rows.length >= 60 && <p className="small muted">Showing the first 60. Narrow the search to see others.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
