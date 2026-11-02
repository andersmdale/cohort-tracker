// Editable path inventory: where each study's data lives, by modality. Every change is logged.
import { HttpError, type Db } from './db';
import { logEvent } from './services';

const KEY = /^[a-z][a-z0-9_]*$/;
const MODS = ['smri', 'dmri', 'fmri', 'pet', 'eeg', 'genomics', 'biospecimen', 'assessment'];

export interface LocationInput {
  study?: string; modality?: string | null; key?: string; path?: string; host?: string; description?: string | null;
}

const label = (r: { study_id: string; modality: string | null; key: string }) =>
  `${r.study_id}${r.modality ? ` ${r.modality}` : ''} ${r.key}`;

export async function addLocation(db: Db, input: LocationInput, actor: string) {
  if (!input.study) throw new HttpError(400, 'Choose a study');
  if (!input.key || !KEY.test(input.key)) throw new HttpError(400, 'Name must be lower_case letters, digits and underscores, e.g. mmps_root');
  if (!input.path?.trim()) throw new HttpError(400, 'Enter a path');
  if (input.modality && !MODS.includes(input.modality)) throw new HttpError(400, `Unknown modality "${input.modality}"`);
  const host = input.host?.trim() || (await db.query<{ host: string }>('SELECT host FROM study WHERE study_id = $1', [input.study])).rows[0]?.host;
  if (!host) throw new HttpError(400, `Unknown study "${input.study}"`);
  try {
    const r = await db.query<{ location_id: string }>(
      `INSERT INTO data_location (study_id, modality, key, path, host, description, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING location_id`,
      [input.study, input.modality || null, input.key, input.path.trim(), host, input.description ?? null, actor]);
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'location', actor, actorKind: 'person',
      note: `Added ${label({ study_id: input.study, modality: input.modality ?? null, key: input.key })} = ${input.path.trim()}`,
    });
    return Number(r.rows[0].location_id);
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new HttpError(409, `${input.study} already has "${input.key}" for ${input.modality || 'all modalities'}; edit that entry instead`);
    throw e;
  }
}

export async function updateLocation(db: Db, id: number, input: LocationInput, actor: string) {
  const r = await db.query('SELECT * FROM data_location WHERE location_id = $1 FOR UPDATE', [id]);
  if (!r.rowCount) throw new HttpError(404, `Path entry ${id} does not exist`);
  const old = r.rows[0];
  const path = input.path !== undefined ? input.path.trim() : old.path;
  if (!path) throw new HttpError(400, 'Enter a path');
  const host = input.host !== undefined ? input.host.trim() || old.host : old.host;
  const description = input.description !== undefined ? input.description || null : old.description;
  await db.query(
    `UPDATE data_location SET path = $2, host = $3, description = $4, updated_by = $5, updated_at = now() WHERE location_id = $1`,
    [id, path, host, description, actor]);
  const changes = [
    path !== old.path ? `path ${old.path} → ${path}` : null,
    host !== old.host ? `host ${old.host} → ${host}` : null,
    description !== old.description ? 'description updated' : null,
  ].filter(Boolean);
  if (changes.length) {
    await logEvent(db, {
      pipelineId: null, stepKey: null, unitIds: [], kind: 'location', actor, actorKind: 'person',
      note: `Edited ${label(old)}: ${changes.join('; ')}`,
    });
  }
}

export async function deleteLocation(db: Db, id: number, actor: string) {
  const r = await db.query('DELETE FROM data_location WHERE location_id = $1 RETURNING *', [id]);
  if (!r.rowCount) throw new HttpError(404, `Path entry ${id} does not exist`);
  await logEvent(db, {
    pipelineId: null, stepKey: null, unitIds: [], kind: 'location', actor, actorKind: 'person',
    note: `Removed ${label(r.rows[0])} (was ${r.rows[0].path})`,
  });
}
