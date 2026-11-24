import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_CATALOG,
  type ModelInfo,
  STRATEGY_PRESETS,
  type Strategy,
} from '../core/models.ts';
import type { Plan } from '../core/plan.ts';
import type { ProviderConfig } from '../providers/registry.ts';
import type { RepoAnalysis } from './analyzer.ts';

export interface ProjectInput {
  name: string;
  description: string;
  /** Preferred languages, frameworks, databases and infrastructure. */
  stack: string[];
  /** Rules, constraints and coding standards every agent must follow. */
  instructions: string;
  deliverables: string[];
  acceptanceCriteria: string[];
  /** Folder the agents work in. Created if it does not exist. */
  workspace: string;
  /** Optional GitHub repository URL, informational in this version. */
  repository?: string;
}

export interface Project extends ProjectInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export type PlanStatus = 'draft' | 'approved';

export interface PlanRecord {
  id: string;
  projectId: string;
  version: number;
  status: PlanStatus;
  plan: Plan;
  /** How the plan was made: which model, at what cost, from what analysis. */
  origin: {
    model: string;
    usage: { inputTokens: number; outputTokens: number };
    cost: number | null;
    analysis: RepoAnalysis | null;
  };
  createdAt: string;
}

export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface RunSettings {
  concurrency: number;
  /** Stop the run when the estimated spend reaches this many US dollars. */
  budgetUsd: number;
  /** Let agents with the run_commands permission execute shell commands (each needs approval). */
  allowCommands: boolean;
  /** Rounds of tool calls an agent may make for one task. */
  maxTurns: number;
}

export interface RunRecord {
  id: string;
  projectId: string;
  planId: string;
  status: RunStatus;
  settings: RunSettings;
  /** Latest state snapshot written by the runtime (see runtime/state.ts). */
  state: unknown;
  startedAt: string;
  endedAt: string | null;
}

export interface StoredEvent {
  runId: string;
  seq: number;
  at: string;
  type: string;
  data: unknown;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10)}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, base_url TEXT,
  enabled INTEGER NOT NULL, secret TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS models (
  provider TEXT NOT NULL, id TEXT NOT NULL, info TEXT NOT NULL, PRIMARY KEY (provider, id)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, status TEXT NOT NULL, plan TEXT NOT NULL, origin TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (project_id, version)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id), status TEXT NOT NULL, settings TEXT NOT NULL,
  state TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
`;

/** All persistence, on the SQLite engine built into Node: nothing to install or host. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.#seed();
  }

  close(): void {
    this.db.close();
  }

  // settings

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  strategy(): Strategy {
    return this.getSetting('strategy', STRATEGY_PRESETS.balanced);
  }

  // providers

  listProviders(): (ProviderConfig & { secret: string | null })[] {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at').all() as {
      id: string;
      kind: ProviderConfig['kind'];
      label: string;
      base_url: string | null;
      enabled: number;
      secret: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      ...(r.base_url ? { baseURL: r.base_url } : {}),
      enabled: r.enabled === 1,
      secret: r.secret,
    }));
  }

  saveProvider(config: ProviderConfig, sealedSecret: string | null | undefined): void {
    const existing = this.db.prepare('SELECT secret FROM providers WHERE id = ?').get(config.id) as
      | { secret: string | null }
      | undefined;
    // undefined keeps the stored key; null removes it.
    const secret = sealedSecret === undefined ? (existing?.secret ?? null) : sealedSecret;
    this.db
      .prepare(
        `INSERT INTO providers (id, kind, label, base_url, enabled, secret, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, label = excluded.label,
           base_url = excluded.base_url, enabled = excluded.enabled, secret = excluded.secret`,
      )
      .run(
        config.id,
        config.kind,
        config.label,
        config.baseURL ?? null,
        config.enabled ? 1 : 0,
        secret,
        new Date().toISOString(),
      );
  }

  deleteProvider(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM models WHERE provider = ?').run(id);
  }

  // models

  listModels(): ModelInfo[] {
    const rows = this.db.prepare('SELECT info FROM models ORDER BY provider, id').all() as {
      info: string;
    }[];
    return rows.map((r) => JSON.parse(r.info) as ModelInfo);
  }

  saveModel(model: ModelInfo): void {
    this.db
      .prepare(
        'INSERT INTO models (provider, id, info) VALUES (?, ?, ?) ON CONFLICT(provider, id) DO UPDATE SET info = excluded.info',
      )
      .run(model.provider, model.id, JSON.stringify(model));
  }

  /** Adds models that are not known yet; never overwrites ratings the user or catalog set. */
  addModelsIfMissing(models: readonly ModelInfo[]): number {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO models (provider, id, info) VALUES (?, ?, ?)',
    );
    let added = 0;
    for (const model of models) {
      added += Number(insert.run(model.provider, model.id, JSON.stringify(model)).changes);
    }
    return added;
  }

  // projects

  listProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? toProject(row) : undefined;
  }

  createProject(input: ProjectInput): Project {
    const now = new Date().toISOString();
    const id = newId('prj');
    this.db
      .prepare('INSERT INTO projects (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(input), now, now);
    return { id, ...input, createdAt: now, updatedAt: now };
  }

  updateProject(id: string, input: ProjectInput): Project | undefined {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE projects SET data = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(input), now, id);
    return result.changes ? this.getProject(id) : undefined;
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // plans

  listPlans(projectId: string): PlanRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM plans WHERE project_id = ? ORDER BY version DESC')
      .all(projectId) as unknown as PlanRow[];
    return rows.map(toPlan);
  }

  getPlan(id: string): PlanRecord | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanRow | undefined;
    return row ? toPlan(row) : undefined;
  }

  /** Saves a new version; plans are never edited in place, so every run keeps its exact plan. */
  createPlan(projectId: string, plan: Plan, origin: PlanRecord['origin']): PlanRecord {
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM plans WHERE project_id = ?')
      .get(projectId) as { next: number };
    const record: PlanRecord = {
      id: newId('pln'),
      projectId,
      version: next,
      status: 'draft',
      plan,
      origin,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO plans (id, project_id, version, status, plan, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        projectId,
        record.version,
        record.status,
        JSON.stringify(plan),
        JSON.stringify(origin),
        record.createdAt,
      );
    this.#touchProject(projectId);
    return record;
  }

  approvePlan(id: string): void {
    this.db.prepare("UPDATE plans SET status = 'approved' WHERE id = ?").run(id);
  }

  // runs

  listRuns(projectId: string): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at DESC')
      .all(projectId) as unknown as RunRow[];
    return rows.map(toRun);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  createRun(projectId: string, planId: string, settings: RunSettings): RunRecord {
    const record: RunRecord = {
      id: newId('run'),
      projectId,
      planId,
      status: 'running',
      settings,
      state: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.db
      .prepare(
        'INSERT INTO runs (id, project_id, plan_id, status, settings, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        record.id,
        projectId,
        planId,
        record.status,
        JSON.stringify(settings),
        'null',
        record.startedAt,
      );
    this.#touchProject(projectId);
    return record;
  }

  updateRun(id: string, status: RunStatus, state: unknown): void {
    const ended = status === 'running' || status === 'paused' ? null : new Date().toISOString();
    this.db
      .prepare(
        'UPDATE runs SET status = ?, state = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?',
      )
      .run(status, JSON.stringify(state), ended, id);
  }

  /** Runs left "running" by a previous process cannot resume their in-memory agents. */
  failInterruptedRuns(): number {
    return Number(
      this.db
        .prepare(
          "UPDATE runs SET status = 'failed', ended_at = ? WHERE status IN ('running', 'paused')",
        )
        .run(new Date().toISOString()).changes,
    );
  }

  // events

  appendEvent(event: StoredEvent): void {
    this.db
      .prepare('INSERT INTO events (run_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(event.runId, event.seq, event.at, event.type, JSON.stringify(event.data));
  }

  listEvents(runId: string, afterSeq = 0, limit = 5000): StoredEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, afterSeq, limit) as {
      run_id: string;
      seq: number;
      at: string;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({
      runId: r.run_id,
      seq: r.seq,
      at: r.at,
      type: r.type,
      data: JSON.parse(r.data),
    }));
  }

  #touchProject(id: string): void {
    this.db
      .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  #seed(): void {
    this.addModelsIfMissing(DEFAULT_CATALOG);
    const hasMock = this.db.prepare("SELECT 1 FROM providers WHERE id = 'mock'").get();
    if (!hasMock && this.getSetting('seeded', false) === false) {
      this.saveProvider(
        { id: 'mock', kind: 'mock', label: 'Mock (offline demo)', enabled: true },
        null,
      );
      this.setSetting('seeded', true);
    }
  }
}

interface ProjectRow {
  id: string;
  data: string;
  created_at: string;
  updated_at: string;
}
interface PlanRow {
  id: string;
  project_id: string;
  version: number;
  status: PlanStatus;
  plan: string;
  origin: string;
  created_at: string;
}
interface RunRow {
  id: string;
  project_id: string;
  plan_id: string;
  status: RunStatus;
  settings: string;
  state: string;
  started_at: string;
  ended_at: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    ...(JSON.parse(row.data) as ProjectInput),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlan(row: PlanRow): PlanRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status,
    plan: JSON.parse(row.plan) as Plan,
    origin: JSON.parse(row.origin) as PlanRecord['origin'],
    createdAt: row.created_at,
  };
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    planId: row.plan_id,
    status: row.status,
    settings: JSON.parse(row.settings) as RunSettings,
    state: JSON.parse(row.state),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
