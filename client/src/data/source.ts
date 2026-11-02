import type { ItemPatch, Snapshot } from '../../../shared/types';

export type ConnectionStatus = 'connecting' | 'live' | 'error';

export interface TrackerState {
  snapshot: Snapshot | null;
  status: ConnectionStatus;
  paused: boolean;
  error: string | null;
}

/** What the UI needs from a data source. Implemented by ApiSource (server) and MockSource (in-browser). */
export interface TrackerSource {
  readonly mode: 'api' | 'mock';
  subscribe(listener: () => void): () => void;
  getState(): TrackerState;
  setPaused(paused: boolean): void;
  retryFailed(pipelineId: string, stepKey: string, actor: string): Promise<void>;
  assignTask(taskId: number, assignee: string | null, actor: string): Promise<void>;
  completeTask(taskId: number, actor: string): Promise<void>;
  updateItem(itemId: string, patch: ItemPatch, actor: string): Promise<void>;
  runItem(itemId: string, actor: string): Promise<void>;
}

export abstract class BaseSource {
  protected state: TrackerState = { snapshot: null, status: 'connecting', paused: false, error: null };
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getState = () => this.state;

  protected set(patch: Partial<TrackerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
}
