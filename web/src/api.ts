import type { ModelInfo, Strategy } from '../../src/core/models.ts';
import type { ModelRef, Plan } from '../../src/core/plan.ts';
import type { RunEvent, RunState } from '../../src/core/run-state.ts';
import type { RepoAnalysis } from '../../src/server/analyzer.ts';
import type {
  PlanRecord,
  Project,
  ProjectInput,
  RunRecord,
  RunSettings,
} from '../../src/server/store.ts';

export type {
  ModelInfo,
  ModelRef,
  Plan,
  PlanRecord,
  Project,
  ProjectInput,
  RepoAnalysis,
  RunRecord,
  RunSettings,
  RunState,
  Strategy,
};

export interface ProviderView {
  id: string;
  kind: 'anthropic' | 'openai' | 'google' | 'openai-compatible' | 'mock';
  label: string;
  baseURL?: string;
  enabled: boolean;
  hasKey: boolean;
  maskedKey: string | null;
  usable: boolean;
}

export interface SettingsView {
  strategy: Strategy;
  presets: Record<string, Strategy>;
  available: ModelRef[];
  demoMode: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly issues: string[];
  constructor(status: number, message: string, issues: string[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(response.status, data.error ?? response.statusText, data.issues ?? []);
  return data as T;
}

export const api = {
  settings: () => request<SettingsView>('GET', '/api/settings'),
  setStrategy: (strategy: Strategy) => request('PUT', '/api/settings/strategy', strategy),

  providers: () => request<ProviderView[]>('GET', '/api/providers'),
  saveProvider: (
    id: string,
    input: {
      kind: ProviderView['kind'];
      label: string;
      baseURL?: string;
      enabled: boolean;
      apiKey?: string | null;
    },
  ) => request('PUT', `/api/providers/${id}`, input),
  deleteProvider: (id: string) => request('DELETE', `/api/providers/${id}`),
  syncProvider: (id: string) =>
    request<{ models: number; added: number }>('POST', `/api/providers/${id}/sync`, {}),

  models: () => request<ModelInfo[]>('GET', '/api/models'),
  saveModel: (model: ModelInfo) => request<ModelInfo>('PUT', '/api/models', model),

  projects: () => request<Project[]>('GET', '/api/projects'),
  project: (id: string) =>
    request<{ project: Project; plans: PlanRecord[]; runs: Omit<RunRecord, 'state'>[] }>(
      'GET',
      `/api/projects/${id}`,
    ),
  createProject: (input: ProjectInput) => request<Project>('POST', '/api/projects', input),
  updateProject: (id: string, input: ProjectInput) =>
    request<Project>('PUT', `/api/projects/${id}`, input),
  deleteProject: (id: string) => request('DELETE', `/api/projects/${id}`),
  analyze: (id: string) => request<RepoAnalysis>('POST', `/api/projects/${id}/analyze`, {}),
  files: (id: string) => request<{ files: string[] }>('GET', `/api/projects/${id}/files`),
  file: (id: string, path: string) =>
    request<{ content: string }>(
      'GET',
      `/api/projects/${id}/files?path=${encodeURIComponent(path)}`,
    ),

  generatePlan: (projectId: string, planner?: ModelRef) =>
    request<{ plan: PlanRecord; unassigned: string[]; attempts: number }>(
      'POST',
      `/api/projects/${projectId}/plans/generate`,
      planner ? { planner } : {},
    ),
  savePlan: (projectId: string, plan: Plan, basedOn?: string) =>
    request<{ plan: PlanRecord; unassigned: string[] }>(
      'POST',
      `/api/projects/${projectId}/plans`,
      { plan, basedOn },
    ),
  assignModels: (plan: Plan, keepExisting: boolean) =>
    request<{ plan: Plan; unassigned: string[] }>('POST', '/api/plans/assign-models', {
      plan,
      keepExisting,
    }),
  approvePlan: (planId: string) => request('POST', `/api/plans/${planId}/approve`, {}),

  startRun: (projectId: string, planId: string, settings: RunSettings) =>
    request<RunRecord>('POST', `/api/projects/${projectId}/runs`, { planId, settings }),
  run: (id: string) =>
    request<RunRecord & { state: RunState; live: boolean }>('GET', `/api/runs/${id}`),
  pause: (id: string) => request('POST', `/api/runs/${id}/pause`, {}),
  resume: (id: string) => request('POST', `/api/runs/${id}/resume`, {}),
  cancel: (id: string) => request('POST', `/api/runs/${id}/cancel`, {}),
  setBudget: (id: string, budgetUsd: number) =>
    request('POST', `/api/runs/${id}/budget`, { budgetUsd }),
  answer: (runId: string, escalationId: string, answer: string) =>
    request('POST', `/api/runs/${runId}/escalations/${escalationId}`, { answer }),
  approve: (runId: string, approvalId: string, approve: boolean) =>
    request('POST', `/api/runs/${runId}/approvals/${approvalId}`, { approve }),
};

/** Subscribes to a run's events; returns a function that closes the stream. */
export function streamRun(
  runId: string,
  after: number,
  onEvent: (event: RunEvent) => void,
): () => void {
  const source = new EventSource(`/api/runs/${runId}/events?after=${after}`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as RunEvent;
    onEvent(event);
    // The server ends the stream after the final phase; do not let the browser reconnect.
    if (
      event.type === 'run.phase' &&
      ['completed', 'failed', 'cancelled'].includes(event.data.phase)
    ) {
      source.close();
    }
  };
  return () => source.close();
}

export function money(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
