import { existsSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, type ModelInfo, STRATEGY_PRESETS } from '../src/core/models.ts';
import type { Plan } from '../src/core/plan.ts';
import { applyEvent, emptyRunState, type RunEvent, type RunState } from '../src/core/run-state.ts';
import { MockProvider } from '../src/providers/mock.ts';
import {
  type ChatProvider,
  type ChatRequest,
  type Part,
  ProviderError,
} from '../src/providers/types.ts';
import { Orchestrator } from '../src/server/runtime/orchestrator.ts';
import { Workspace, WorkspaceError } from '../src/server/runtime/workspace.ts';
import type { Project, RunSettings } from '../src/server/store.ts';
import { samplePlan } from './fixtures.ts';

const mockModel = DEFAULT_CATALOG.find((m) => m.provider === 'mock')!;

function withMockModels(plan: Plan): Plan {
  return {
    ...plan,
    agents: plan.agents.map((a) => ({ ...a, model: { provider: 'mock', id: 'mock-model' } })),
  };
}

function harness(options: {
  plan?: Plan;
  providers?: Record<string, ChatProvider>;
  catalog?: ModelInfo[];
  settings?: Partial<RunSettings>;
}) {
  const workspace = mkdtempSync(join(tmpdir(), 'polyphony-run-'));
  const project: Project = {
    id: 'prj_test',
    name: 'Notes',
    description: 'A notes API.',
    stack: [],
    instructions: '',
    deliverables: [],
    acceptanceCriteria: [],
    workspace,
    createdAt: '',
    updatedAt: '',
  };
  const state: RunState = emptyRunState('run_test');
  const events: RunEvent[] = [];
  let seq = 0;
  const providers = options.providers ?? { mock: new MockProvider({ delayMs: 0 }) };
  const orchestrator = new Orchestrator({
    project,
    plan: options.plan ?? withMockModels(samplePlan()),
    settings: {
      concurrency: 3,
      budgetUsd: 0,
      allowCommands: false,
      maxTurns: 10,
      ...options.settings,
    },
    catalog: options.catalog ?? [mockModel],
    strategy: STRATEGY_PRESETS.balanced,
    getProvider: (id) => providers[id],
    state,
    emit: (type, data) => {
      seq += 1;
      const event = { seq, at: new Date().toISOString(), type, data } as RunEvent;
      events.push(event);
      applyEvent(state, event);
    },
  });
  return { orchestrator, state, events, workspace };
}

/** A provider driven by a function from the request to the parts of its answer. */
function scripted(
  id: string,
  answer: (request: ChatRequest) => Part[] | Promise<Part[]>,
): ChatProvider {
  let n = 0;
  return {
    id,
    listModels: async () => [],
    chat: async (request) => {
      const parts = await answer(request);
      return {
        message: {
          role: 'assistant',
          parts: parts.map((p) => (p.type === 'tool_call' ? { ...p, id: `${id}_${++n}` } : p)),
        },
        stop: parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'end',
        usage: { inputTokens: 1000, outputTokens: 100 },
      };
    },
  };
}

const call = (name: string, input: unknown): Part => ({ type: 'tool_call', id: '', name, input });
const taskOf = (request: ChatRequest) =>
  /Task id: ([\w-]+)/.exec(JSON.stringify(request.messages))?.[1] ?? '';
const answered = (request: ChatRequest) =>
  request.messages.at(-1)?.parts.some((p) => p.type === 'tool_result') ?? false;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('Orchestrator', () => {
  it('runs a whole plan with the offline model, in dependency order, with reviews', async () => {
    const { orchestrator, state, events, workspace } = harness({});
    expect(await orchestrator.run()).toBe('completed');

    expect(Object.values(state.tasks).map((t) => t.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    for (const id of ['design', 'api', 'tests', 'docs']) {
      expect(existsSync(join(workspace, 'deliverables', `${id}.md`))).toBe(true);
    }
    const reviews = events
      .filter((e) => e.type === 'review')
      .map((e) => (e.type === 'review' ? e.data : null));
    // "api" names a reviewer; "tests" is reviewed by the parent of its subagent.
    expect(reviews.map((r) => [r?.task, r?.reviewer])).toEqual(
      expect.arrayContaining([
        ['api', 'reviewer'],
        ['tests', 'api-dev'],
      ]),
    );
    const started = events
      .filter((e) => e.type === 'task.status' && e.data.status === 'running')
      .map((e) => (e.type === 'task.status' ? e.data.task : ''));
    expect(started.indexOf('design')).toBe(0);
    expect(started.indexOf('docs')).toBe(started.length - 1);
    expect(state.agents.architect?.status).toBe('completed');
    expect(state.inputTokens).toBeGreaterThan(0);
    expect(state.cost).toBe(0);
  });

  it('skips everything downstream of a failed task', async () => {
    const provider = scripted('mock', (request) => {
      if (taskOf(request) === 'api') return [{ type: 'text', text: 'I give up.' }];
      if (request.tools.some((t) => t.name === 'submit_review')) {
        return [call('submit_review', { verdict: 'approve', notes: 'fine' })];
      }
      return answered(request)
        ? [call('complete_task', { summary: 'done' })]
        : [call('read_shared_context', {})];
    });
    const { orchestrator, state } = harness({ providers: { mock: provider } });
    expect(await orchestrator.run()).toBe('failed');
    expect(state.tasks.api?.status).toBe('failed');
    expect(state.tasks.tests?.status).toBe('done');
    expect(state.tasks.docs?.status).toBe('skipped');
  });

  it('switches to another model when a provider fails', async () => {
    const broken = scripted('broken', () => {
      throw new ProviderError('broken', 'auth', 'bad key');
    });
    const plan = withMockModels(samplePlan());
    plan.agents[0] = { ...plan.agents[0]!, model: { provider: 'broken', id: 'x' } };
    const { orchestrator, state, events } = harness({
      plan,
      providers: { broken, mock: new MockProvider({ delayMs: 0 }) },
    });
    expect(await orchestrator.run()).toBe('completed');
    const switched = events.find((e) => e.type === 'agent.model');
    expect(switched?.type === 'agent.model' && switched.data).toMatchObject({
      agent: 'architect',
      model: { provider: 'mock' },
      reason: 'bad key',
    });
    expect(state.agents.architect?.model?.provider).toBe('mock');
  });

  it('refuses a write to a file another agent is changing in parallel', async () => {
    const plan = withMockModels(samplePlan());
    plan.tasks = [
      { ...plan.tasks[0]!, id: 'a', agent: 'architect', dependsOn: [] },
      { ...plan.tasks[0]!, id: 'b', agent: 'api-dev', dependsOn: [] },
    ];
    plan.channels = [];
    const provider = scripted('mock', async (request) => {
      const task = taskOf(request);
      if (!answered(request)) {
        if (task === 'b') await new Promise((r) => setTimeout(r, 20));
        return [call('write_file', { path: 'shared.md', content: task })];
      }
      if (task === 'a') await new Promise((r) => setTimeout(r, 80));
      return [call('complete_task', { summary: 'ok' })];
    });
    const { orchestrator, state, workspace } = harness({ plan, providers: { mock: provider } });
    await orchestrator.run();
    expect(state.conflicts).toEqual([
      expect.objectContaining({ path: 'shared.md', agents: ['architect', 'api-dev'] }),
    ]);
    expect(readFileSync(join(workspace, 'shared.md'), 'utf8')).toBe('a');
  });

  it('waits for the operator to answer an escalation', async () => {
    const plan = withMockModels(samplePlan());
    plan.tasks = [{ ...plan.tasks[0]!, dependsOn: [] }];
    const provider = scripted('mock', (request) => {
      const last = JSON.stringify(request.messages.at(-1));
      if (!answered(request)) return [call('escalate', { question: 'Which currency?' })];
      expect(last).toContain('The operator answered: CAD');
      return [call('complete_task', { summary: 'Used CAD.' })];
    });
    const { orchestrator, state } = harness({ plan, providers: { mock: provider } });
    const done = orchestrator.run();
    await until(() => state.escalations.length > 0);
    expect(state.agents.architect?.status).toBe('waiting');
    expect(orchestrator.answerEscalation(state.escalations[0]!.id, 'CAD')).toBe(true);
    expect(await done).toBe('completed');
    expect(state.tasks.design?.summary).toBe('Used CAD.');
  });

  it('pauses at the budget and finishes after it is raised', async () => {
    const priced: ModelInfo = { ...mockModel, inputPrice: 10, outputPrice: 10 };
    const { orchestrator, state } = harness({
      catalog: [priced],
      settings: { budgetUsd: 0.02, concurrency: 1 },
    });
    const done = orchestrator.run();
    await until(() => state.phase === 'paused');
    expect(state.phase).toBe('paused');
    const costAtPause = state.cost;
    await new Promise((r) => setTimeout(r, 30));
    expect(state.cost).toBe(costAtPause);
    orchestrator.setBudget(100);
    orchestrator.resume();
    expect(await done).toBe('completed');
    expect(state.cost).toBeGreaterThan(costAtPause);
  });

  it('cancels a run', async () => {
    const { orchestrator, state } = harness({
      providers: { mock: new MockProvider({ delayMs: 50 }) },
    });
    const done = orchestrator.run();
    await until(() => state.tasks.design?.status === 'running');
    orchestrator.cancel();
    expect(await done).toBe('cancelled');
    expect(Object.values(state.tasks).every((t) => t.status === 'cancelled')).toBe(true);
  });

  it('keeps commands off unless the run allows them', async () => {
    const plan = withMockModels(samplePlan());
    plan.tasks = [{ ...plan.tasks[0]!, dependsOn: [] }];
    plan.agents[0] = { ...plan.agents[0]!, permissions: ['run_commands'] };
    let result = '';
    const provider = scripted('mock', (request) => {
      if (!answered(request)) return [call('run_command', { command: 'echo hi' })];
      result = JSON.stringify(request.messages.at(-1));
      return [call('complete_task', { summary: 'ok' })];
    });
    const { orchestrator } = harness({ plan, providers: { mock: provider } });
    await orchestrator.run();
    expect(result).toContain('turned off');
  });

  it('runs an approved command and reports its output', async () => {
    const plan = withMockModels(samplePlan());
    plan.tasks = [{ ...plan.tasks[0]!, dependsOn: [] }];
    plan.agents[0] = { ...plan.agents[0]!, permissions: ['run_commands'] };
    let result = '';
    const provider = scripted('mock', (request) => {
      if (!answered(request)) return [call('run_command', { command: 'echo polyphony' })];
      result = JSON.stringify(request.messages.at(-1));
      return [call('complete_task', { summary: 'ok' })];
    });
    const { orchestrator, state } = harness({
      plan,
      providers: { mock: provider },
      settings: { allowCommands: true },
    });
    const done = orchestrator.run();
    await until(() => state.approvals.length > 0);
    orchestrator.resolveApproval(state.approvals[0]!.id, true);
    await done;
    expect(result).toContain('exit 0');
    expect(result).toContain('polyphony');
  });
});

describe('Workspace', () => {
  it('keeps every path inside the root', () => {
    const ws = new Workspace(mkdtempSync(join(tmpdir(), 'polyphony-ws-')));
    expect(ws.write('src/a.ts', 'x')).toBe('src/a.ts');
    // A drive path is only absolute on Windows; elsewhere it is an ordinary file name.
    const windowsOnly = process.platform === 'win32' ? ['C:\\Windows\\x'] : [];
    for (const bad of ['../escape.txt', '/etc/passwd', 'src/../../x', ...windowsOnly]) {
      expect(() => ws.resolve(bad)).toThrow(WorkspaceError);
    }
  });

  it('does not follow symlinks out of the root', () => {
    const root = mkdtempSync(join(tmpdir(), 'polyphony-ws-'));
    const outside = mkdtempSync(join(tmpdir(), 'polyphony-out-'));
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return; // symlinks not permitted on this machine
    }
    expect(() => new Workspace(root).write('link/x.txt', 'x')).toThrow(WorkspaceError);
  });

  it('edits only unique matches', () => {
    const ws = new Workspace(mkdtempSync(join(tmpdir(), 'polyphony-ws-')));
    ws.write('a.txt', 'one two two');
    expect(() => ws.edit('a.txt', 'two', '2')).toThrow('more than once');
    ws.edit('a.txt', 'one', '1');
    expect(ws.read('a.txt')).toBe('1 two two');
    expect(ws.search('TWO')).toEqual(['a.txt:1: 1 two two']);
  });
});
