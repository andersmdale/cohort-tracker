import type { ItemPatch, Snapshot, UnitRow } from '../../../shared/types';
import { BaseSource, type LocationPatch, type TrackerSource } from './source';

/** Reads the snapshot from the server and refreshes it whenever the SSE stream reports a change. */
export class ApiSource extends BaseSource implements TrackerSource {
  readonly mode = 'api' as const;
  private timer: number | undefined;
  private missed = false;

  constructor(private base: string) {
    super();
    void this.refresh();
    this.connect();
  }

  private connect() {
    const es = new EventSource(`${this.base}/api/stream`);
    es.onopen = () => {
      this.set({ status: 'live', error: null });
      void this.refresh();
    };
    es.addEventListener('change', () => this.schedule());
    // EventSource reconnects on its own; just report the state.
    es.onerror = () => this.set({ status: 'error', error: 'Lost connection to the tracker server. Reconnecting…' });
  }

  private schedule() {
    if (this.state.paused) { this.missed = true; return; }
    if (this.timer !== undefined) return;
    // Coalesce bursts of events into one fetch
    this.timer = window.setTimeout(() => { this.timer = undefined; void this.refresh(); }, 250);
  }

  private async refresh() {
    try {
      const r = await fetch(`${this.base}/api/snapshot`);
      if (!r.ok) throw new Error(`The server returned ${r.status} for the snapshot.`);
      const snapshot = (await r.json()) as Snapshot;
      this.set({ snapshot });
    } catch (e) {
      this.set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  setPaused = (paused: boolean) => {
    this.set({ paused });
    if (!paused && this.missed) { this.missed = false; this.schedule(); }
  };

  private async call(path: string, method: string, body: unknown) {
    const r = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const err = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? `Request failed (${r.status})`);
    }
    // Show the result of your own action even while the feed is paused
    await this.refresh();
  }

  retryFailed = (pipelineId: string, stepKey: string, actor: string) =>
    this.call(`/api/pipelines/${encodeURIComponent(pipelineId)}/steps/${encodeURIComponent(stepKey)}/retry`, 'POST', { actor });

  assignTask = (taskId: number, assignee: string | null, actor: string) =>
    this.call(`/api/tasks/${taskId}`, 'PATCH', { assignee, actor });

  completeTask = (taskId: number, actor: string) =>
    this.call(`/api/tasks/${taskId}/complete`, 'POST', { actor });

  updateItem = (itemId: string, patch: ItemPatch, actor: string) => {
    const { outputPath, ...rest } = patch;
    return this.call(`/api/items/${encodeURIComponent(itemId)}`, 'PATCH',
      { ...rest, ...(outputPath !== undefined ? { output_path: outputPath } : {}), actor });
  };

  addLocation = (entry: LocationPatch, actor: string) => this.call('/api/locations', 'POST', { ...entry, actor });

  updateLocation = (id: number, patch: LocationPatch, actor: string) => this.call(`/api/locations/${id}`, 'PATCH', { ...patch, actor });

  deleteLocation = (id: number, actor: string) => this.call(`/api/locations/${id}`, 'DELETE', { actor });

  fetchUnits = async (q: { study?: string; modality?: string; subject?: string }) => {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]);
    const r = await fetch(`${this.base}/api/units?${params}`);
    if (!r.ok) {
      const err = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? `Request failed (${r.status})`);
    }
    return (await r.json()) as UnitRow[];
  };

  runItem = (itemId: string, actor: string) =>
    this.call(`/api/items/${encodeURIComponent(itemId)}/run`, 'POST', { actor });
}
