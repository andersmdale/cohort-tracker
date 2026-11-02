// Fixed vocabularies and small helpers shared by server and client.
// Study-specific settings live in shared/studies.yaml (see config.ts).

export type ModalityKey =
  | 'smri' | 'dmri' | 'fmri' | 'pet' | 'eeg' | 'genomics' | 'biospecimen' | 'assessment';

export const MODALITIES: ReadonlyArray<{ key: ModalityKey; label: string }> = [
  { key: 'smri', label: 'sMRI' },
  { key: 'dmri', label: 'dMRI' },
  { key: 'fmri', label: 'fMRI' },
  { key: 'pet', label: 'PET' },
  { key: 'eeg', label: 'EEG' },
  { key: 'genomics', label: 'Genomics' },
  { key: 'biospecimen', label: 'Biospec.' },
  { key: 'assessment', label: 'Assess.' },
];

export const MODALITY_LABEL = Object.fromEntries(
  MODALITIES.map((m) => [m.key, m.label]),
) as Record<ModalityKey, string>;

export type Role = 'study_lead' | 'qc_reviewer' | 'data_manager' | 'genomics_analyst' | 'lab_liaison';

export const ROLES: Role[] = ['study_lead', 'qc_reviewer', 'data_manager', 'genomics_analyst', 'lab_liaison'];

export const ROLE_LABEL: Record<Role, string> = {
  study_lead: 'Study lead',
  qc_reviewer: 'QC reviewer',
  data_manager: 'Data manager',
  genomics_analyst: 'Genomics analyst',
  lab_liaison: 'Lab liaison',
};

export type PipelineKind = 'mri' | 'pet' | 'eeg' | 'genomics' | 'biospecimen' | 'assessment';

export const MODALITY_KIND: Record<ModalityKey, PipelineKind> = {
  smri: 'mri', dmri: 'mri', fmri: 'mri', pet: 'pet', eeg: 'eeg',
  genomics: 'genomics', biospecimen: 'biospecimen', assessment: 'assessment',
};

export interface PersonDef { name: string; role: Role }

export const pipelineIdFor = (study: string, modality: ModalityKey) =>
  `${study.toLowerCase()}-${modality}`;

export const FAILURE_REASONS = [
  'QC_MOTION', 'MISSING_SERIES', 'CHECKSUM_MISMATCH', 'HEADER_INCONSISTENT', 'TIMEOUT',
] as const;

// ---------- deterministic starting distribution (seed script and mock mode) ----------

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SeedDistribution {
  released: number;
  notReceived: number;
  steps: { queued: number; running: number; failed: number }[];
}

/** Spread `expected` units over not-received, in-flight steps and released. Sums exactly to `expected`. */
export function seedDistribution(
  steps: { mode: 'auto' | 'manual' }[],
  expected: number,
  shares: { released: number; notReceived: number },
  rand: () => number,
): SeedDistribution {
  const done = Math.min(0.996, shares.released * (0.9 + rand() * 0.17));
  const rest = expected - Math.round(expected * done);
  const notReceived = Math.round(rest * shares.notReceived);
  const inflight = rest - notReceived;
  const last = steps.length - 1;
  const weights = steps.map((s, i) => (s.mode === 'manual' ? 4 : i === last ? 0.5 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const out = steps.map((s, i) => {
    const share = Math.round((inflight * weights[i]) / total);
    const failed = s.mode === 'manual' ? 0 : Math.round(share * 0.07 * rand());
    const running = s.mode === 'manual' ? 0 : Math.round(share * 0.12 * rand());
    return { queued: share - failed - running, running, failed };
  });
  const inSteps = out.reduce((a, s) => a + s.queued + s.running + s.failed, 0);
  const released = expected - notReceived - inSteps;
  if (released < 0) out[0].queued += released; // rounding guard for tiny pipelines
  return { released: Math.max(0, released), notReceived, steps: out };
}
