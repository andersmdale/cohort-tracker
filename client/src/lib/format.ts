import type { PipelineStatus, Task } from '../../../shared/types';

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const fmt = (n: number) =>
  n >= 100_000 ? `${(n / 1000).toFixed(0)}k` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');

export const pct = (a: number, b: number) => (b ? (a / b) * 100 : 0);

export const pctLabel = (v: number) => (v >= 99.95 ? '100%' : `${v.toFixed(1)}%`);

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export type DueState = 'ok' | 'due' | 'overdue';

export const ageDays = (t: Task, now: number) => (now - Date.parse(t.createdAt)) / 864e5;

export function dueState(t: Task, now: number): DueState {
  const a = ageDays(t, now);
  return a > t.slaDays ? 'overdue' : a > t.slaDays * 0.7 ? 'due' : 'ok';
}

export const inFlight = (p: PipelineStatus) => sum(p.steps.map((s) => s.queued + s.running));
export const failed = (p: PipelineStatus) => sum(p.steps.map((s) => s.failed));
export const waitingOnPeople = (p: PipelineStatus) =>
  sum(p.steps.filter((s) => s.mode === 'manual').map((s) => s.queued));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-12-15" → "Dec 15, 2026" (or "Dec 15" when short). */
export function fmtDate(ymd: string, short = false) {
  const [y, m, d] = ymd.split('-').map(Number);
  return short ? `${MONTHS[m - 1]} ${d}` : `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function ago(iso: string, now: number) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Due date for a deliverable item: its own, else its deliverable's. */
export const itemOverdue = (due: string | null, now: number) => !!due && Date.parse(`${due}T23:59:59`) < now;
