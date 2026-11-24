import type { ModelRef, Plan } from './plan.ts';

/**
 * The live state of a run, rebuilt from its event log by `applyEvent`. The server and the web
 * dashboard run the same reducer, so what the dashboard shows is exactly what the server knows.
 */

export type AgentStatus =
  | 'idle'
  | 'planning'
  | 'working'
  | 'reviewing'
  | 'waiting'
  | 'completed'
  | 'failed';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'in_review'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export type RunPhase = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface AgentState {
  id: string;
  name: string;
  role: string;
  layer: string;
  parent: string | null;
  model: ModelRef | null;
  status: AgentStatus;
  currentTask: string | null;
  activity: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Calls whose cost could not be computed because the model's price is unknown. */
  unpricedCalls: number;
  calls: number;
  toolCalls: number;
  tasksDone: number;
}

export interface TaskState {
  id: string;
  title: string;
  agent: string;
  reviewer: string | null;
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  summary: string | null;
  reviewNotes: string | null;
  files: string[];
  error: string | null;
}

export interface Escalation {
  id: string;
  agent: string;
  task: string;
  question: string;
  answer: string | null;
  at: string;
}

export interface Approval {
  id: string;
  agent: string;
  task: string;
  command: string;
  decision: 'pending' | 'approved' | 'denied';
  at: string;
}

export interface AgentMessage {
  id: string;
  from: string;
  /** An agent id, or "*" for everyone. */
  to: string;
  text: string;
  task: string;
  at: string;
}

export interface LogEntry {
  seq: number;
  at: string;
  agent: string | null;
  task: string | null;
  kind: 'info' | 'tool' | 'thought' | 'message' | 'warning' | 'error' | 'review';
  text: string;
}

export interface RunState {
  runId: string;
  phase: RunPhase;
  startedAt: string;
  endedAt: string | null;
  budgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  unpricedCalls: number;
  agents: Record<string, AgentState>;
  tasks: Record<string, TaskState>;
  escalations: Escalation[];
  approvals: Approval[];
  messages: AgentMessage[];
  /** path -> who wrote it last */
  files: Record<string, { agent: string; task: string; at: string }>;
  conflicts: { path: string; agents: string[]; at: string }[];
  log: LogEntry[];
  lastSeq: number;
}

/** Every event the runtime emits. `data` shapes are listed per type. */
export type RunEvent =
  | Ev<'run.started', { plan: Plan; budgetUsd: number }>
  | Ev<'run.phase', { phase: RunPhase; reason?: string }>
  | Ev<
      'task.status',
      { task: string; status: TaskStatus; summary?: string; error?: string; reviewNotes?: string }
    >
  | Ev<'agent.status', { agent: string; status: AgentStatus; task?: string | null }>
  | Ev<'agent.activity', { agent: string; task: string; text: string }>
  | Ev<'agent.model', { agent: string; model: ModelRef; reason: string }>
  | Ev<
      'llm.usage',
      {
        agent: string;
        task: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        cost: number | null;
      }
    >
  | Ev<'tool.call', { agent: string; task: string; tool: string; summary: string; ok: boolean }>
  | Ev<'file.written', { agent: string; task: string; path: string }>
  | Ev<'conflict', { path: string; agents: string[] }>
  | Ev<'message', { id: string; from: string; to: string; text: string; task: string }>
  | Ev<'escalation.opened', { id: string; agent: string; task: string; question: string }>
  | Ev<'escalation.answered', { id: string; answer: string }>
  | Ev<'approval.requested', { id: string; agent: string; task: string; command: string }>
  | Ev<'approval.resolved', { id: string; decision: 'approved' | 'denied' }>
  | Ev<
      'review',
      { task: string; reviewer: string; verdict: 'approve' | 'request_changes'; notes: string }
    >
  | Ev<'log', { agent?: string; task?: string; kind: LogEntry['kind']; text: string }>;

interface Ev<T extends string, D> {
  seq: number;
  at: string;
  type: T;
  data: D;
}

const MAX_LOG = 2000;

export function emptyRunState(runId: string): RunState {
  return {
    runId,
    phase: 'running',
    startedAt: new Date(0).toISOString(),
    endedAt: null,
    budgetUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    unpricedCalls: 0,
    agents: {},
    tasks: {},
    escalations: [],
    approvals: [],
    messages: [],
    files: {},
    conflicts: [],
    log: [],
    lastSeq: 0,
  };
}

/** Applies one event. Mutates and returns `state`; events at or below lastSeq are ignored. */
export function applyEvent(state: RunState, event: RunEvent): RunState {
  if (event.seq <= state.lastSeq) return state;
  state.lastSeq = event.seq;
  const log = (entry: Omit<LogEntry, 'seq' | 'at'>) => {
    state.log.push({ seq: event.seq, at: event.at, ...entry });
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  };

  switch (event.type) {
    case 'run.started': {
      const { plan, budgetUsd } = event.data;
      state.startedAt = event.at;
      state.budgetUsd = budgetUsd;
      for (const agent of plan.agents) {
        state.agents[agent.id] = {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          layer: agent.layer,
          parent: agent.parent ?? null,
          model: agent.model ?? null,
          status: 'idle',
          currentTask: null,
          activity: '',
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          unpricedCalls: 0,
          calls: 0,
          toolCalls: 0,
          tasksDone: 0,
        };
      }
      const parentOf = new Map(plan.agents.map((a) => [a.id, a.parent ?? null]));
      for (const task of plan.tasks) {
        state.tasks[task.id] = {
          id: task.id,
          title: task.title,
          agent: task.agent,
          reviewer: task.reviewer ?? parentOf.get(task.agent) ?? null,
          dependsOn: task.dependsOn,
          status: 'pending',
          attempts: 0,
          startedAt: null,
          endedAt: null,
          summary: null,
          reviewNotes: null,
          files: [],
          error: null,
        };
      }
      log({
        agent: null,
        task: null,
        kind: 'info',
        text: `Run started: ${plan.agents.length} agents, ${plan.tasks.length} tasks.`,
      });
      break;
    }
    case 'run.phase': {
      state.phase = event.data.phase;
      if (['completed', 'failed', 'cancelled'].includes(event.data.phase)) state.endedAt = event.at;
      log({
        agent: null,
        task: null,
        kind: event.data.phase === 'failed' ? 'error' : 'info',
        text: `Run ${event.data.phase}${event.data.reason ? `: ${event.data.reason}` : ''}.`,
      });
      break;
    }
    case 'task.status': {
      const task = state.tasks[event.data.task];
      if (!task) break;
      task.status = event.data.status;
      if (event.data.status === 'running') {
        task.attempts += 1;
        task.startedAt ??= event.at;
        task.error = null;
      }
      if (['done', 'failed', 'skipped', 'cancelled'].includes(event.data.status))
        task.endedAt = event.at;
      if (event.data.summary !== undefined) task.summary = event.data.summary;
      if (event.data.error !== undefined) task.error = event.data.error;
      if (event.data.reviewNotes !== undefined) task.reviewNotes = event.data.reviewNotes;
      if (event.data.status === 'done') {
        const agent = state.agents[task.agent];
        if (agent) {
          agent.tasksDone += 1;
          agent.activity = `Finished “${task.title}”.`;
        }
      }
      log({
        agent: task.agent,
        task: task.id,
        kind: event.data.status === 'failed' ? 'error' : 'info',
        text: `Task "${task.title}" ${event.data.status.replace('_', ' ')}${event.data.error ? `: ${event.data.error}` : ''}.`,
      });
      break;
    }
    case 'agent.status': {
      const agent = state.agents[event.data.agent];
      if (!agent) break;
      agent.status = event.data.status;
      if (event.data.task !== undefined) agent.currentTask = event.data.task;
      break;
    }
    case 'agent.activity': {
      const agent = state.agents[event.data.agent];
      if (agent) agent.activity = event.data.text;
      log({
        agent: event.data.agent,
        task: event.data.task,
        kind: 'thought',
        text: event.data.text,
      });
      break;
    }
    case 'agent.model': {
      const agent = state.agents[event.data.agent];
      if (agent) agent.model = event.data.model;
      log({
        agent: event.data.agent,
        task: null,
        kind: 'warning',
        text: `Switched to ${event.data.model.provider}/${event.data.model.id}: ${event.data.reason}`,
      });
      break;
    }
    case 'llm.usage': {
      const { inputTokens, outputTokens, cost } = event.data;
      state.inputTokens += inputTokens;
      state.outputTokens += outputTokens;
      const agent = state.agents[event.data.agent];
      if (agent) {
        agent.inputTokens += inputTokens;
        agent.outputTokens += outputTokens;
        agent.calls += 1;
      }
      if (cost === null) {
        state.unpricedCalls += 1;
        if (agent) agent.unpricedCalls += 1;
      } else {
        state.cost += cost;
        if (agent) agent.cost += cost;
      }
      break;
    }
    case 'tool.call': {
      const agent = state.agents[event.data.agent];
      if (agent) agent.toolCalls += 1;
      log({
        agent: event.data.agent,
        task: event.data.task,
        kind: event.data.ok ? 'tool' : 'warning',
        text: `${event.data.tool}: ${event.data.summary}`,
      });
      break;
    }
    case 'file.written': {
      state.files[event.data.path] = {
        agent: event.data.agent,
        task: event.data.task,
        at: event.at,
      };
      const task = state.tasks[event.data.task];
      if (task && !task.files.includes(event.data.path)) task.files.push(event.data.path);
      break;
    }
    case 'conflict': {
      state.conflicts.push({ path: event.data.path, agents: event.data.agents, at: event.at });
      log({
        agent: null,
        task: null,
        kind: 'warning',
        text: `Conflict on ${event.data.path} between ${event.data.agents.join(' and ')}.`,
      });
      break;
    }
    case 'message': {
      state.messages.push({ ...event.data, at: event.at });
      log({
        agent: event.data.from,
        task: event.data.task,
        kind: 'message',
        text: `→ ${event.data.to === '*' ? 'everyone' : event.data.to}: ${event.data.text}`,
      });
      break;
    }
    case 'escalation.opened': {
      state.escalations.push({ ...event.data, answer: null, at: event.at });
      log({
        agent: event.data.agent,
        task: event.data.task,
        kind: 'warning',
        text: `Needs a decision: ${event.data.question}`,
      });
      break;
    }
    case 'escalation.answered': {
      const escalation = state.escalations.find((e) => e.id === event.data.id);
      if (escalation) escalation.answer = event.data.answer;
      break;
    }
    case 'approval.requested': {
      state.approvals.push({ ...event.data, decision: 'pending', at: event.at });
      log({
        agent: event.data.agent,
        task: event.data.task,
        kind: 'warning',
        text: `Wants to run: ${event.data.command}`,
      });
      break;
    }
    case 'approval.resolved': {
      const approval = state.approvals.find((a) => a.id === event.data.id);
      if (approval) approval.decision = event.data.decision;
      break;
    }
    case 'review': {
      log({
        agent: event.data.reviewer,
        task: event.data.task,
        kind: 'review',
        text: `${event.data.verdict === 'approve' ? 'Approved' : 'Requested changes'}: ${event.data.notes}`,
      });
      break;
    }
    case 'log': {
      log({
        agent: event.data.agent ?? null,
        task: event.data.task ?? null,
        kind: event.data.kind,
        text: event.data.text,
      });
      break;
    }
  }
  return state;
}

/** Tasks whose dependencies are all done and that have not started. */
export function readyTasks(state: RunState): TaskState[] {
  return Object.values(state.tasks).filter(
    (task) =>
      task.status === 'pending' &&
      task.dependsOn.every((dep) => state.tasks[dep]?.status === 'done'),
  );
}

/** Progress from 0 to 1, counting finished tasks. */
export function progress(state: RunState): number {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) return 0;
  const finished = tasks.filter((t) =>
    ['done', 'skipped', 'failed', 'cancelled'].includes(t.status),
  );
  return finished.length / tasks.length;
}
