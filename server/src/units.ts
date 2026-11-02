// Subject x visit units: creating them (import) and listing them with their paths (subject browser).
import type pg from 'pg';
import type { Db } from './db';
import { HttpError } from './db';
import { studyContext, unitPath } from './paths';
import type { ModalityKey } from '../../shared/catalog';
import type { UnitRow, UnitState } from '../../shared/types';

export interface PipelineDef {
  id: string; study: string; modality: ModalityKey;
  steps: { key: string; name: string; ordinal: number; mode: string; output: string | null; launch: string }[];
}

export async function pipelineDefs(db: Db, filter: { study?: string; modality?: string } = {}): Promise<PipelineDef[]> {
  const p = await db.query<{ pipeline_id: string; study_id: string; modality: ModalityKey }>(
    `SELECT pipeline_id, study_id, modality FROM pipeline
      WHERE ($1::text IS NULL OR study_id = $1) AND ($2::text IS NULL OR modality = $2) ORDER BY pipeline_id`,
    [filter.study ?? null, filter.modality ?? null]);
  const s = await db.query('SELECT pipeline_id, step_key, name, ordinal, mode, output, launch FROM step ORDER BY pipeline_id, ordinal');
  return p.rows.map((r) => ({
    id: r.pipeline_id, study: r.study_id, modality: r.modality,
    steps: s.rows.filter((x) => x.pipeline_id === r.pipeline_id)
      .map((x) => ({ key: x.step_key, name: x.name, ordinal: x.ordinal, mode: x.mode, output: x.output, launch: x.launch })),
  }));
}

export interface UnitPosition { subject: string; visit: string; stepKey: string | null; state: UnitState; paths?: Record<string, string> }

/**
 * Create units that don't exist yet and move existing ones forward to the given position.
 * Units are never moved backwards here, and excluded units are left alone.
 * Returns how many were created and how many advanced.
 */
export async function upsertUnits(db: pg.PoolClient, p: PipelineDef, rows: UnitPosition[]) {
  if (!rows.length) return { created: 0, advanced: 0 };
  const ord = new Map(p.steps.map((s) => [s.key, s.ordinal]));
  const rank = (stepKey: string | null, state: string) =>
    state === 'released' ? 1e6 : state === 'expected' ? -1 : (ord.get(stepKey ?? '') ?? 0);
  const subjects = [...new Set(rows.map((r) => r.subject))];
  await db.query(
    `INSERT INTO participant (study_id, participant_id) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [p.study, subjects]);
  const sid = (r: UnitPosition) => `${p.study}/${r.subject}/${r.visit}`;
  await db.query(
    `INSERT INTO session (session_id, study_id, participant_id, visit)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) ON CONFLICT DO NOTHING`,
    [rows.map(sid), rows.map(() => p.study), rows.map((r) => r.subject), rows.map((r) => r.visit)]);
  const existing = await db.query<{ session_id: string; unit_id: string; step_key: string | null; state: string }>(
    'SELECT session_id, unit_id, step_key, state FROM work_unit WHERE pipeline_id = $1 AND session_id = ANY($2)',
    [p.id, rows.map(sid)]);
  const have = new Map(existing.rows.map((r) => [r.session_id, r]));
  const fresh = rows.filter((r) => !have.has(sid(r)));
  if (fresh.length) {
    await db.query(
      `INSERT INTO work_unit (session_id, pipeline_id, step_key, state, paths)
       SELECT s, $1, k, st, pth::jsonb FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(s, k, st, pth)
       ON CONFLICT DO NOTHING`,
      [p.id, fresh.map(sid), fresh.map((r) => r.stepKey), fresh.map((r) => r.state), fresh.map((r) => JSON.stringify(r.paths ?? {}))]);
  }
  let advanced = 0;
  for (const r of rows) {
    const e = have.get(sid(r));
    if (!e || e.state === 'excluded') continue;
    if (rank(r.stepKey, r.state) > rank(e.step_key, e.state)) {
      await db.query(
        `UPDATE work_unit SET step_key = $2, state = $3, attempts = 0, paths = paths || $4::jsonb, updated_at = now() WHERE unit_id = $1`,
        [e.unit_id, r.stepKey, r.state, JSON.stringify(r.paths ?? {})]);
      advanced++;
    } else if (r.paths && Object.keys(r.paths).length) {
      await db.query(`UPDATE work_unit SET paths = paths || $2::jsonb WHERE unit_id = $1`, [e.unit_id, JSON.stringify(r.paths)]);
    }
  }
  return { created: fresh.length, advanced };
}

/** Subject browser: units matching a subject search, with each step's output path. */
export async function listUnits(db: Db, q: { study?: string; modality?: string; subject?: string; limit?: number }): Promise<UnitRow[]> {
  if (!q.study && !q.subject) throw new HttpError(400, 'Choose a study or type a subject id');
  const r = await db.query(
    `SELECT w.unit_id, w.pipeline_id, w.step_key, w.state, w.paths, p.study_id, p.modality, se.participant_id, se.visit
       FROM work_unit w
       JOIN pipeline p USING (pipeline_id)
       JOIN session se USING (session_id)
       JOIN study st ON st.study_id = p.study_id
      WHERE ($1::text IS NULL OR p.study_id = $1)
        AND ($2::text IS NULL OR p.modality = $2)
        AND ($3::text IS NULL OR se.participant_id ILIKE $3 || '%')
      ORDER BY se.participant_id, array_position(st.visits, se.visit), se.visit, p.modality
      LIMIT $4`,
    [q.study ?? null, q.modality ?? null, q.subject?.trim() || null, Math.min(q.limit ?? 60, 500)]);
  const defs = new Map((await pipelineDefs(db, { study: q.study })).map((d) => [d.id, d]));
  const ctx = new Map<string, Awaited<ReturnType<typeof studyContext>>>();
  const out: UnitRow[] = [];
  for (const u of r.rows) {
    const d = defs.get(u.pipeline_id);
    if (!d) continue;
    if (!ctx.has(u.study_id)) ctx.set(u.study_id, await studyContext(db, u.study_id));
    const c = ctx.get(u.study_id)!;
    const cur = u.state === 'released' ? Infinity : u.state === 'expected' ? -1 : (d.steps.find((s) => s.key === u.step_key)?.ordinal ?? 0);
    out.push({
      unitId: Number(u.unit_id), pipelineId: u.pipeline_id, study: u.study_id, modality: u.modality,
      subject: u.participant_id, visit: u.visit, stepKey: u.step_key, state: u.state,
      paths: d.steps.map((s) => ({
        stepKey: s.key, stepName: s.name, passed: s.ordinal < cur,
        path: (u.paths as Record<string, string>)[s.key]
          ?? (s.output ? unitPath(s.output, c.locations, { study: u.study_id, modality: u.modality, release: c.release, subject: u.participant_id, visit: u.visit }) : null),
      })),
    });
  }
  return out;
}
