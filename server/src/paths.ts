// Path inventory helpers: template rendering per study/modality, ~ expansion, and discovery of
// subject/visit folders on disk from a template such as "~/data/ABCD/raw/{subject}/{visit}".
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Db } from './db';
import { renderPath, type ModalityKey } from '../../shared/catalog';
import { pathVars } from '../../shared/config';

export interface Loc { modality: ModalityKey | null; key: string; path: string }

export async function studyContext(db: Db, study: string) {
  const [locs, s] = await Promise.all([
    db.query<Loc>('SELECT modality, key, path FROM data_location WHERE study_id = $1', [study]),
    db.query<{ release: string | null; host: string; visits: string[] }>('SELECT release, host, visits FROM study WHERE study_id = $1', [study]),
  ]);
  if (!s.rowCount) throw new Error(`Unknown study "${study}"`);
  return { locations: locs.rows, release: s.rows[0].release, host: s.rows[0].host, visits: s.rows[0].visits };
}

/** Render a step output template for one subject/visit. */
export function unitPath(template: string, locs: Loc[], ctx: { study: string; modality: ModalityKey; release: string | null; subject: string; visit: string }) {
  return renderPath(template, pathVars(locs, ctx));
}

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

export const exists = (p: string) => existsSync(expandHome(p));

const esc = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

/**
 * Find every {subject}/{visit} combination for which a path matching `template` exists.
 * Only {subject} and {visit} may remain as placeholders; each may appear inside a path segment
 * (e.g. "MRIPROC_{subject}_{visit}").
 */
export function discover(template: string): { subject: string; visit: string | null; path: string }[] {
  const full = path.resolve(expandHome(template));
  const leftover = full.match(/\{([a-z_]+)\}/g)?.filter((m) => m !== '{subject}' && m !== '{visit}');
  if (leftover?.length) throw new Error(`Template still has unknown placeholders: ${leftover.join(', ')} in ${template}`);
  const segs = full.split('/').slice(1);
  const out: { subject: string; visit: string | null; path: string }[] = [];
  const walk = (dir: string, i: number, caps: { subject?: string; visit?: string }) => {
    if (i === segs.length) {
      if (caps.subject) out.push({ subject: caps.subject, visit: caps.visit ?? null, path: dir });
      return;
    }
    const seg = segs[i];
    if (!seg.includes('{')) {
      const next = path.join(dir, seg);
      if (i === segs.length - 1 ? existsSync(next) : isDir(next)) walk(next, i + 1, caps);
      return;
    }
    const re = new RegExp(`^${esc(seg).replace(/\{(subject|visit)\}/g, (_m, k: string) => `(?<${k}>[^/]+?)`)}$`);
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const m = re.exec(e);
      if (!m) continue;
      const g = m.groups ?? {};
      if ((g.subject && caps.subject && g.subject !== caps.subject) || (g.visit && caps.visit && g.visit !== caps.visit)) continue;
      walk(path.join(dir, e), i + 1, { subject: g.subject ?? caps.subject, visit: g.visit ?? caps.visit });
    }
  };
  walk('/', 0, {});
  return out;
}

function isDir(p: string) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
