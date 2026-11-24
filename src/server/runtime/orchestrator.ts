import { spawn } from 'node:child_process';
import { costOf, type ModelInfo, type Strategy, selectModel } from '../../core/models.ts';
import type { Agent, ModelRef, Plan, Task } from '../../core/plan.ts';
import { type RunEvent, type RunPhase, type RunState, readyTasks } from '../../core/run-state.ts';
import { type ChatProvider, type Effort, ProviderError } from '../../providers/types.ts';
import type { Project, RunSettings } from '../store.ts';
import { LoopError, type LoopResult, runAgentLoop, ToolRefusal } from './agent-loop.ts';
import { type ToolContext, toolsFor } from './tools.ts';
import { Workspace } from './workspace.ts';

type Emit = <T extends RunEvent['type']>(
  type: T,
  data: Extract<RunEvent, { type: T }>['data'],
) => void;

export interface OrchestratorOptions {
  project: Project;
  plan: Plan;
  settings: RunSettings;
  /** Enabled models of configured providers: the pool for fallbacks. */
  catalog: ModelInfo[];
  strategy: Strategy;
  getProvider(providerId: string): ChatProvider | undefined;
  state: RunState;
  emit: Emit;
}

const MAX_REVIEW_ROUNDS = 2;
const MAX_MODEL_SWITCHES = 2;

/**
 * Runs an approved plan. The orchestrator schedules tasks whose dependencies are done (in
 * parallel, one task per agent at a time), routes work to reviewers, enforces the budget and
 * switches models when a provider fails. It does not sit between agents: they message each
 * other directly, and only escalations, command approvals and scheduling go through it.
 */
export class Orchestrator {
  readonly #o: OrchestratorOptions;
  readonly #workspace: Workspace;
  readonly #abort = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #busyAgents = new Set<string>();
  readonly #inboxes = new Map<string, { from: string; text: string }[]>();
  readonly #escalations = new Map<string, (answer: string) => void>();
  readonly #approvals = new Map<string, (approved: boolean) => void>();
  readonly #writers = new Map<string, { agent: string; task: string }>();
  readonly #agents: Map<string, Agent>;
  readonly #tasks: Map<string, Task>;
  #paused = false;
  #wake: () => void = () => {};
  #counter = 0;

  constructor(options: OrchestratorOptions) {
    this.#o = options;
    this.#workspace = new Workspace(options.project.workspace);
    this.#agents = new Map(options.plan.agents.map((a) => [a.id, a]));
    this.#tasks = new Map(options.plan.tasks.map((t) => [t.id, t]));
  }

  get paused(): boolean {
    return this.#paused;
  }

  async run(): Promise<RunPhase> {
    const { emit, state, settings } = this.#o;
    emit('run.started', { plan: this.#o.plan, budgetUsd: settings.budgetUsd });
    for (const agent of this.#o.plan.agents) {
      if (!agent.model) {
        emit('log', {
          agent: agent.id,
          kind: 'warning',
          text: 'No model is assigned; a fallback will be chosen.',
        });
      }
    }

    while (!this.#abort.signal.aborted) {
      if (!this.#paused) {
        for (const task of readyTasks(state)) {
          if (this.#running.size >= settings.concurrency) break;
          if (this.#busyAgents.has(task.agent)) continue;
          this.#start(task.id);
        }
      }
      if (this.#running.size === 0 && !this.#paused) break;
      const wake = new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      await Promise.race([...this.#running.values(), wake]);
    }
    await Promise.allSettled(this.#running.values());

    // Whatever never became ready is skipped, because something it needs did not finish.
    for (const task of Object.values(state.tasks)) {
      if (task.status === 'pending') {
        emit('task.status', {
          task: task.id,
          status: this.#abort.signal.aborted ? 'cancelled' : 'skipped',
          error: this.#abort.signal.aborted
            ? 'run cancelled'
            : 'a task it depends on did not finish',
        });
      }
    }
    for (const agent of Object.values(state.agents)) {
      const mine = Object.values(state.tasks).filter((t) => t.agent === agent.id);
      // Agents without tasks of their own (reviewers) count as completed when the run is.
      const status =
        agent.status === 'failed'
          ? 'failed'
          : mine.every((t) => t.status === 'done') && !this.#abort.signal.aborted
            ? 'completed'
            : 'idle';
      emit('agent.status', { agent: agent.id, status, task: null });
    }
    const failed = Object.values(state.tasks).some((t) => t.status === 'failed');
    const phase: RunPhase = this.#abort.signal.aborted
      ? 'cancelled'
      : failed
        ? 'failed'
        : 'completed';
    emit('run.phase', {
      phase,
      ...(failed && phase === 'failed' ? { reason: 'some tasks failed' } : {}),
    });
    return phase;
  }

  pause(reason = 'paused by the operator'): void {
    if (this.#paused) return;
    this.#paused = true;
    this.#o.emit('run.phase', { phase: 'paused', reason });
  }

  resume(): void {
    if (!this.#paused) return;
    this.#paused = false;
    this.#o.emit('run.phase', { phase: 'running' });
    this.#wake();
  }

  cancel(): void {
    this.#abort.abort(new Error('cancelled'));
    for (const resolve of this.#escalations.values()) resolve('(the run was cancelled)');
    for (const resolve of this.#approvals.values()) resolve(false);
    this.#paused = false;
    this.#wake();
  }

  /** Raises the budget, e.g. after the run paused on it. */
  setBudget(budgetUsd: number): void {
    this.#o.settings.budgetUsd = budgetUsd;
    this.#o.state.budgetUsd = budgetUsd;
    this.#o.emit('log', { kind: 'info', text: `Budget set to $${budgetUsd.toFixed(2)}.` });
  }

  answerEscalation(id: string, answer: string): boolean {
    const resolve = this.#escalations.get(id);
    if (!resolve) return false;
    this.#escalations.delete(id);
    this.#o.emit('escalation.answered', { id, answer });
    resolve(answer);
    return true;
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const resolve = this.#approvals.get(id);
    if (!resolve) return false;
    this.#approvals.delete(id);
    this.#o.emit('approval.resolved', { id, decision: approved ? 'approved' : 'denied' });
    resolve(approved);
    return true;
  }

  #start(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task) return;
    this.#busyAgents.add(task.agent);
    const promise = this.#execute(task).finally(() => {
      this.#running.delete(taskId);
      this.#busyAgents.delete(task.agent);
      this.#wake();
    });
    this.#running.set(taskId, promise);
  }

  async #execute(task: Task): Promise<void> {
    const { emit, state } = this.#o;
    const agent = this.#agents.get(task.agent);
    if (!agent) return;
    const reviewerId = state.tasks[task.id]?.reviewer ?? null;
    let notes: string | null = null;

    try {
      for (let round = 0; ; round++) {
        emit('task.status', {
          task: task.id,
          status: 'running',
          ...(notes ? { reviewNotes: notes } : {}),
        });
        emit('agent.status', { agent: agent.id, status: 'working', task: task.id });
        const result = await this.#withModel(agent, task, 'work', notes);
        if (result.kind !== 'complete') throw new LoopError('the agent did not complete the task');
        const summary = result.summary;

        const reviewer = reviewerId ? this.#agents.get(reviewerId) : undefined;
        if (!reviewer) {
          this.#finish(task, agent, summary);
          return;
        }
        emit('task.status', { task: task.id, status: 'in_review', summary });
        emit('agent.status', { agent: agent.id, status: 'waiting', task: task.id });
        emit('agent.status', { agent: reviewer.id, status: 'reviewing', task: task.id });
        const review = await this.#withModel(reviewer, task, 'review', summary);
        emit('agent.status', {
          agent: reviewer.id,
          status: this.#busyAgents.has(reviewer.id) ? 'working' : 'idle',
          task: this.#busyAgents.has(reviewer.id)
            ? (state.agents[reviewer.id]?.currentTask ?? null)
            : null,
        });
        if (review.kind !== 'review') throw new LoopError('the reviewer did not submit a review');
        emit('review', {
          task: task.id,
          reviewer: reviewer.id,
          verdict: review.verdict,
          notes: review.notes,
        });
        if (review.verdict === 'approve') {
          this.#finish(task, agent, summary);
          return;
        }
        if (round + 1 >= MAX_REVIEW_ROUNDS) {
          emit('log', {
            agent: reviewer.id,
            task: task.id,
            kind: 'warning',
            text: `Accepted after ${MAX_REVIEW_ROUNDS} review rounds with open notes: ${review.notes}`,
          });
          this.#finish(task, agent, summary);
          return;
        }
        notes = review.notes;
      }
    } catch (error) {
      const cancelled = this.#abort.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      emit('task.status', {
        task: task.id,
        status: cancelled ? 'cancelled' : 'failed',
        error: message,
      });
      emit('agent.status', { agent: agent.id, status: cancelled ? 'idle' : 'failed', task: null });
    }
  }

  #finish(task: Task, agent: Agent, summary: string): void {
    this.#o.emit('task.status', { task: task.id, status: 'done', summary });
    this.#o.emit('agent.status', { agent: agent.id, status: 'idle', task: null });
  }

  /**
   * Runs the agent loop on the agent's model. If the provider fails (bad key, outage, rate
   * limit, unknown model), switches to the next best available model and tries again.
   */
  async #withModel(
    agent: Agent,
    task: Task,
    mode: 'work' | 'review',
    extra: string | null,
  ): Promise<LoopResult> {
    const { state, emit, catalog } = this.#o;
    const failed = new Set<string>();
    for (let switches = 0; ; switches++) {
      let ref: ModelRef | null = state.agents[agent.id]?.model ?? null;
      let provider = ref ? this.#o.getProvider(ref.provider) : undefined;
      if (!ref || !provider) {
        const fallback = this.#fallback(agent, failed);
        if (!fallback) throw new LoopError('no available model can run this agent');
        emit('agent.model', {
          agent: agent.id,
          model: fallback,
          reason: ref ? `provider "${ref.provider}" is not configured` : 'no model was assigned',
        });
        ref = fallback;
        provider = this.#o.getProvider(ref.provider);
        if (!provider) throw new LoopError('no available model can run this agent');
      }
      const model = catalog.find((m) => m.provider === ref.provider && m.id === ref.id);
      try {
        return await runAgentLoop({
          provider,
          model: ref.id,
          effort: effortFor(agent),
          system: mode === 'work' ? this.#workSystem(agent) : this.#reviewSystem(agent),
          prompt:
            mode === 'work'
              ? this.#workPrompt(agent, task, extra)
              : this.#reviewPrompt(task, extra ?? ''),
          tools: toolsFor(agent, mode),
          context: this.#context(agent, task),
          maxTurns: this.#o.settings.maxTurns,
          signal: this.#abort.signal,
          beforeCall: () => this.#gate(),
          takeInbox: () => this.#drain(agent.id),
          onUsage: (usage) => {
            emit('llm.usage', {
              agent: agent.id,
              task: task.id,
              model: ref.id,
              ...usage,
              cost: costOf(model, usage),
            });
            const budget = this.#o.settings.budgetUsd;
            if (budget > 0 && state.cost >= budget)
              this.pause(`budget of $${budget.toFixed(2)} reached`);
          },
          onThought: (text) => emit('agent.activity', { agent: agent.id, task: task.id, text }),
          onTool: (tool, summary, ok) =>
            emit('tool.call', { agent: agent.id, task: task.id, tool, summary, ok }),
        });
      } catch (error) {
        if (
          !(error instanceof ProviderError) ||
          switches >= MAX_MODEL_SWITCHES ||
          this.#abort.signal.aborted
        ) {
          throw error;
        }
        failed.add(`${ref.provider}/${ref.id}`);
        if (error.kind === 'auth') failed.add(`${ref.provider}/*`);
        const fallback = this.#fallback(agent, failed);
        if (!fallback) throw error;
        emit('agent.model', { agent: agent.id, model: fallback, reason: error.message });
      }
    }
  }

  #fallback(agent: Agent, failed: Set<string>): ModelRef | undefined {
    const pool = this.#o.catalog.filter(
      (m) =>
        !failed.has(`${m.provider}/${m.id}`) &&
        !failed.has(`${m.provider}/*`) &&
        this.#o.getProvider(m.provider) !== undefined,
    );
    return selectModel(agent.requirements, pool, this.#o.strategy)?.model;
  }

  /** Holds agents between model calls while the run is paused. */
  async #gate(): Promise<void> {
    while (this.#paused && !this.#abort.signal.aborted) {
      await new Promise<void>((resolve) => {
        const previous = this.#wake;
        this.#wake = () => {
          previous();
          resolve();
        };
      });
    }
  }

  #drain(agentId: string): { from: string; text: string }[] {
    const inbox = this.#inboxes.get(agentId) ?? [];
    this.#inboxes.set(agentId, []);
    return inbox;
  }

  #contacts(agent: Agent): string[] {
    const ids = new Set<string>();
    for (const channel of this.#o.plan.channels) {
      if (channel.from === agent.id) ids.add(channel.to);
      if (channel.to === agent.id) ids.add(channel.from);
    }
    if (agent.parent) ids.add(agent.parent);
    for (const other of this.#o.plan.agents) if (other.parent === agent.id) ids.add(other.id);
    return [...ids];
  }

  #context(agent: Agent, task: Task): ToolContext {
    const { emit } = this.#o;
    const guardWrite = (path: string, write: () => string): string => {
      const rel = this.#workspace.rel(this.#workspace.resolve(path));
      const other = this.#writers.get(rel);
      if (
        other &&
        other.agent !== agent.id &&
        this.#running.has(other.task) &&
        other.task !== task.id
      ) {
        emit('conflict', { path: rel, agents: [other.agent, agent.id] });
        throw new ToolRefusal(
          `${rel} is being changed by ${other.agent} in a parallel task. Agree the change with send_message, or write a different file.`,
        );
      }
      const written = write();
      this.#writers.set(written, { agent: agent.id, task: task.id });
      emit('file.written', { agent: agent.id, task: task.id, path: written });
      return written;
    };
    return {
      agent,
      task,
      workspace: this.#workspace,
      contacts: this.#contacts(agent),
      sharedContext: () => this.#sharedContext(),
      writeFile: (path, content) => guardWrite(path, () => this.#workspace.write(path, content)),
      editFile: (path, find, replace) =>
        guardWrite(path, () => this.#workspace.edit(path, find, replace)),
      sendMessage: (to, text) => {
        const id = this.#id('msg');
        emit('message', { id, from: agent.id, to, text, task: task.id });
        const recipients =
          to === '*' ? [...this.#agents.keys()].filter((a) => a !== agent.id) : [to];
        for (const recipient of recipients) {
          const inbox = this.#inboxes.get(recipient) ?? [];
          inbox.push({ from: agent.id, text });
          this.#inboxes.set(recipient, inbox);
        }
      },
      readMessages: () => this.#drain(agent.id),
      escalate: async (question) => {
        const id = this.#id('esc');
        emit('escalation.opened', { id, agent: agent.id, task: task.id, question });
        emit('agent.status', { agent: agent.id, status: 'waiting', task: task.id });
        emit('task.status', { task: task.id, status: 'waiting' });
        const answer = await new Promise<string>((resolve) => this.#escalations.set(id, resolve));
        emit('agent.status', { agent: agent.id, status: 'working', task: task.id });
        emit('task.status', { task: task.id, status: 'running' });
        return answer;
      },
      runCommand: async (command, timeoutSeconds) => {
        if (!this.#o.settings.allowCommands) {
          throw new ToolRefusal(
            'Running commands is turned off for this run. Describe the command in your summary instead.',
          );
        }
        const id = this.#id('cmd');
        emit('approval.requested', { id, agent: agent.id, task: task.id, command });
        emit('agent.status', { agent: agent.id, status: 'waiting', task: task.id });
        const approved = await new Promise<boolean>((resolve) => this.#approvals.set(id, resolve));
        emit('agent.status', { agent: agent.id, status: 'working', task: task.id });
        if (!approved) throw new ToolRefusal('The operator did not approve this command.');
        return runShell(command, this.#workspace.root, timeoutSeconds, this.#abort.signal);
      },
    };
  }

  #team(): string {
    return this.#o.plan.agents
      .map((a) => `- ${a.id}: ${a.role} (${a.layer}${a.parent ? `, subagent of ${a.parent}` : ''})`)
      .join('\n');
  }

  #sharedContext(): string {
    const { project } = this.#o;
    const done = Object.values(this.#o.state.tasks).filter((t) => t.status === 'done');
    return [
      `Project: ${project.name}`,
      project.description,
      '',
      `Architecture: ${this.#o.plan.architecture.stack.join(', ')}. ${this.#o.plan.architecture.notes}`,
      '',
      'Team:',
      this.#team(),
      '',
      'Finished tasks:',
      ...(done.length
        ? done.map(
            (t) =>
              `- ${t.id} (${t.agent}): ${t.summary ?? ''}${t.files.length ? ` Files: ${t.files.join(', ')}` : ''}`,
          )
        : ['- none yet']),
    ].join('\n');
  }

  #workSystem(agent: Agent): string {
    const { project } = this.#o;
    return [
      `You are ${agent.name}, the ${agent.role} on a team of AI agents building "${project.name}".`,
      '',
      'Your responsibilities:',
      ...agent.responsibilities.map((r) => `- ${r}`),
      agent.instructions ? `\n${agent.instructions}` : '',
      '',
      'Project rules and standards:',
      project.instructions.trim() || '(none)',
      '',
      'Your team:',
      this.#team(),
      '',
      'How to work:',
      '- Do the task you are given with your tools. The workspace is shared with your team; read what exists before you change it.',
      '- Stay within your task. Produce the deliverables as real files.',
      '- When you depend on a teammate (an API contract, a schema), agree it with send_message instead of guessing.',
      '- Use escalate only for decisions that genuinely need a human.',
      '- When the task is finished, call complete_task with a short summary and the files you produced.',
    ].join('\n');
  }

  #reviewSystem(agent: Agent): string {
    return [
      `You are ${agent.name}, the ${agent.role}, reviewing a teammate's work on "${this.#o.project.name}".`,
      'Read the files that were produced and judge them against the task and its acceptance criteria.',
      'Approve work that meets them. Request changes only for concrete problems, with notes the author can act on.',
      'Finish by calling submit_review.',
      '',
      'Project rules and standards:',
      this.#o.project.instructions.trim() || '(none)',
    ].join('\n');
  }

  #taskBrief(task: Task): string[] {
    return [
      `Task id: ${task.id}`,
      `Task: ${task.title}`,
      '',
      task.description,
      '',
      'Deliverables:',
      ...task.deliverables.map((d) => `- ${d}`),
      '',
      'Acceptance criteria:',
      ...task.acceptanceCriteria.map((c) => `- ${c}`),
    ];
  }

  #workPrompt(agent: Agent, task: Task, notes: string | null): string {
    const deps = task.dependsOn.map((id) => this.#o.state.tasks[id]).filter((t) => t !== undefined);
    return [
      ...this.#taskBrief(task),
      '',
      'Results of the tasks this one builds on:',
      ...(deps.length
        ? deps.map(
            (t) =>
              `- ${t.title} (${t.agent}): ${t.summary ?? ''}${t.files.length ? `\n  Files: ${t.files.join(', ')}` : ''}`,
          )
        : ['- none: this task starts from the brief.']),
      ...(notes ? ['', 'The reviewer asked for these changes. Address all of them:', notes] : []),
      '',
      `Channels you can use: ${this.#contacts(agent).join(', ') || 'none'}`,
    ].join('\n');
  }

  #reviewPrompt(task: Task, summary: string): string {
    const state = this.#o.state.tasks[task.id];
    return [
      ...this.#taskBrief(task),
      '',
      `The author (${task.agent}) reports:`,
      summary,
      '',
      `Files produced: ${state?.files.join(', ') || 'none reported'}`,
    ].join('\n');
  }

  #id(prefix: string): string {
    this.#counter += 1;
    return `${prefix}_${this.#counter}`;
  }
}

function effortFor(agent: Agent): Effort {
  if (agent.requirements.reasoning >= 5) return 'high';
  if (agent.requirements.reasoning <= 2) return 'low';
  return 'medium';
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Runs an approved command with secrets removed from its environment. */
function runShell(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !SECRET_ENV.test(k)),
    );
    const child = spawn(command, { cwd, shell: true, env, signal, timeout: timeoutSeconds * 1000 });
    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < 20_000) output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve(`Could not run the command: ${error.message}`));
    child.on('close', (code, sig) => {
      const tail = output.length >= 20_000 ? '\n[output truncated]' : '';
      resolve(`exit ${code ?? sig}\n${output.slice(0, 20_000)}${tail}`);
    });
  });
}
