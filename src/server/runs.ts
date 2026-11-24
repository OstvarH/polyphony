import type { ModelInfo, Strategy } from '../core/models.ts';
import type { Plan } from '../core/plan.ts';
import { applyEvent, emptyRunState, type RunEvent, type RunState } from '../core/run-state.ts';
import type { ChatProvider } from '../providers/types.ts';
import { Orchestrator } from './runtime/orchestrator.ts';
import type { Project, RunRecord, RunSettings, Store } from './store.ts';

type Listener = (event: RunEvent) => void;

interface ActiveRun {
  orchestrator: Orchestrator;
  state: RunState;
  listeners: Set<Listener>;
}

/**
 * Owns the runs executing in this process: creates their orchestrators, numbers and stores
 * every event, keeps a state snapshot in the database, and fans events out to dashboards.
 */
export class RunManager {
  readonly #store: Store;
  readonly #active = new Map<string, ActiveRun>();

  constructor(store: Store) {
    this.#store = store;
  }

  start(options: {
    project: Project;
    planId: string;
    plan: Plan;
    settings: RunSettings;
    catalog: ModelInfo[];
    strategy: Strategy;
    providers: Map<string, ChatProvider>;
  }): RunRecord {
    const record = this.#store.createRun(options.project.id, options.planId, options.settings);
    const state = emptyRunState(record.id);
    const listeners = new Set<Listener>();
    let seq = 0;
    let persistTimer: NodeJS.Timeout | undefined;
    const persist = () => {
      persistTimer = undefined;
      this.#store.updateRun(record.id, state.phase, state);
    };

    const orchestrator = new Orchestrator({
      project: options.project,
      plan: options.plan,
      settings: options.settings,
      catalog: options.catalog,
      strategy: options.strategy,
      getProvider: (id) => options.providers.get(id),
      state,
      emit: (type, data) => {
        seq += 1;
        const event = { seq, at: new Date().toISOString(), type, data } as RunEvent;
        this.#store.appendEvent({ runId: record.id, seq, at: event.at, type, data });
        applyEvent(state, event);
        for (const listener of listeners) listener(event);
        persistTimer ??= setTimeout(persist, 500);
      },
    });
    this.#active.set(record.id, { orchestrator, state, listeners });

    orchestrator
      .run()
      .catch((error: unknown) => {
        state.phase = 'failed';
        console.error(`run ${record.id} crashed:`, error);
      })
      .finally(() => {
        clearTimeout(persistTimer);
        persist();
        // Keep it briefly so dashboards receive the final events, then free the memory.
        setTimeout(() => this.#active.delete(record.id), 60_000).unref();
      });
    return record;
  }

  orchestrator(runId: string): Orchestrator | undefined {
    return this.#active.get(runId)?.orchestrator;
  }

  state(runId: string): RunState | undefined {
    return this.#active.get(runId)?.state;
  }

  subscribe(runId: string, listener: Listener): () => void {
    const active = this.#active.get(runId);
    if (!active) return () => {};
    active.listeners.add(listener);
    return () => active.listeners.delete(listener);
  }

  cancelAll(): void {
    for (const { orchestrator } of this.#active.values()) orchestrator.cancel();
  }
}
