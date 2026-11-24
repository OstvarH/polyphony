import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CATALOG, STRATEGY_PRESETS } from '../src/core/models.ts';
import { MockProvider } from '../src/providers/mock.ts';
import type { ChatProvider, ChatRequest, ChatResult } from '../src/providers/types.ts';
import { analyzeRepository, describeAnalysis } from '../src/server/analyzer.ts';
import { assignModels, generatePlan, PlannerError, planToolSchema } from '../src/server/planner.ts';
import { maskSecret, SecretBox } from '../src/server/secrets.ts';
import { Store } from '../src/server/store.ts';
import { samplePlan } from './fixtures.ts';

const project = {
  name: 'Brokerage',
  description:
    'A real estate brokerage management and accounting system with Laravel, PostgreSQL and React.',
  stack: ['Laravel', 'PostgreSQL', 'React'],
  instructions: 'PSR-12. Tests for every endpoint.',
  deliverables: ['Agent commission module'],
  acceptanceCriteria: ['All tests pass'],
  workspace: '/tmp/brokerage',
};
const mockModel = DEFAULT_CATALOG.find((m) => m.provider === 'mock')!;

describe('SecretBox', () => {
  it('round-trips and authenticates', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const sealed = box.seal('sk-ant-secret');
    expect(sealed).not.toContain('secret');
    expect(box.open(sealed)).toBe('sk-ant-secret');
    const tampered = Buffer.from(sealed, 'base64');
    tampered[tampered.length - 1]! ^= 1;
    expect(() => box.open(tampered.toString('base64'))).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed)).toThrow();
  });

  it('masks keys for display', () => {
    expect(maskSecret('sk-ant-api03-abcdefgh')).toBe('sk-a…efgh');
    expect(maskSecret('short')).toBe('•••••');
  });
});

describe('Store', () => {
  it('seeds the catalog and the offline provider', () => {
    const store = new Store(':memory:');
    expect(store.listModels().some((m) => m.id === 'claude-opus-5-5')).toBe(true);
    expect(store.listProviders().map((p) => p.id)).toEqual(['mock']);
  });

  it('versions plans and keeps runs and events', () => {
    const store = new Store(':memory:');
    const p = store.createProject(project);
    const origin = {
      model: 'mock-model',
      usage: { inputTokens: 1, outputTokens: 1 },
      cost: 0,
      analysis: null,
    };
    const v1 = store.createPlan(p.id, samplePlan(), origin);
    const v2 = store.createPlan(p.id, samplePlan(), origin);
    expect([v1.version, v2.version]).toEqual([1, 2]);
    store.approvePlan(v2.id);
    expect(store.getPlan(v2.id)?.status).toBe('approved');

    const run = store.createRun(p.id, v2.id, {
      concurrency: 2,
      budgetUsd: 5,
      allowCommands: false,
      maxTurns: 20,
    });
    store.appendEvent({ runId: run.id, seq: 1, at: 'now', type: 'run.started', data: { a: 1 } });
    store.appendEvent({ runId: run.id, seq: 2, at: 'now', type: 'task.started', data: {} });
    expect(store.listEvents(run.id, 1).map((e) => e.type)).toEqual(['task.started']);
    expect(store.failInterruptedRuns()).toBe(1);
    expect(store.getRun(run.id)?.status).toBe('failed');
  });

  it('keeps a stored key when a provider is updated without one', () => {
    const store = new Store(':memory:');
    const config = {
      id: 'anthropic',
      kind: 'anthropic' as const,
      label: 'Anthropic',
      enabled: true,
    };
    store.saveProvider(config, 'sealed-key');
    store.saveProvider({ ...config, label: 'Renamed' }, undefined);
    expect(store.listProviders().find((p) => p.id === 'anthropic')?.secret).toBe('sealed-key');
  });
});

describe('analyzeRepository', () => {
  it('detects languages, frameworks and structure', () => {
    const root = mkdtempSync(join(tmpdir(), 'polyphony-'));
    mkdirSync(join(root, 'app', 'Models'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(root, 'composer.json'),
      JSON.stringify({ require: { 'laravel/framework': '^11' } }),
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    writeFileSync(join(root, 'app', 'Models', 'Agent.php'), '<?php');
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), '');
    writeFileSync(join(root, 'README.md'), '# Brokerage');
    const analysis = analyzeRepository(root);
    expect(analysis.fileCount).toBe(4);
    expect(analysis.frameworks).toEqual(expect.arrayContaining(['Laravel', 'React']));
    expect(analysis.languages[0]?.language).toBe('PHP');
    expect(analysis.outline).toContain('app/');
    expect(describeAnalysis(analysis)).toContain('# Brokerage');
  });

  it('describes a missing workspace as a new project', () => {
    expect(
      describeAnalysis(analyzeRepository(join(tmpdir(), 'does-not-exist-polyphony'))),
    ).toContain('new project');
  });
});

describe('generatePlan', () => {
  it('produces a valid plan with the offline model', async () => {
    const result = await generatePlan({
      provider: new MockProvider({ delayMs: 0 }),
      model: mockModel,
      project,
      analysis: null,
      catalog: DEFAULT_CATALOG,
    });
    expect(result.attempts).toBe(1);
    expect(result.plan.layers.map((l) => l.id)).toEqual(
      expect.arrayContaining(['data', 'frontend']),
    );
    expect(result.cost).toBe(0);
  });

  it('sends validation problems back until the plan is fixed', async () => {
    const broken = { ...samplePlan(), tasks: [{ ...samplePlan().tasks[0]!, agent: 'ghost' }] };
    const requests: ChatRequest[] = [];
    let call = 0;
    const provider: ChatProvider = {
      id: 'scripted',
      listModels: async () => [],
      chat: async (request): Promise<ChatResult> => {
        requests.push(structuredClone(request));
        call += 1;
        return {
          message: {
            role: 'assistant',
            parts: [
              {
                type: 'tool_call',
                id: `c${call}`,
                name: 'submit_plan',
                input: call === 1 ? broken : samplePlan(),
              },
            ],
          },
          stop: 'tool_calls',
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };
    const result = await generatePlan({
      provider,
      model: mockModel,
      project,
      analysis: null,
      catalog: [],
    });
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    const feedback = requests[1]?.messages.at(-1)?.parts[0];
    expect(feedback).toMatchObject({ type: 'tool_result', isError: true });
    expect(JSON.stringify(feedback)).toContain('unknown agent \\"ghost\\"');
  });

  it('gives up with the last issues', async () => {
    const provider: ChatProvider = {
      id: 'silent',
      listModels: async () => [],
      chat: async () => ({
        message: { role: 'assistant', parts: [{ type: 'text', text: 'Here is my plan...' }] },
        stop: 'end',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const error = await generatePlan({
      provider,
      model: mockModel,
      project,
      analysis: null,
      catalog: [],
      maxAttempts: 2,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(PlannerError);
    expect(error.issues).toEqual(['submit_plan was not called']);
  });

  it('exposes a JSON schema without model fields', () => {
    const schema = JSON.stringify(planToolSchema());
    expect(schema).toContain('"requirements"');
    expect(schema).not.toContain('modelRationale');
    expect(schema).not.toContain('$schema');
  });
});

describe('assignModels', () => {
  const catalog = DEFAULT_CATALOG.filter((m) => m.provider === 'anthropic');

  it('assigns a model with a rationale to every agent', () => {
    const { plan, unassigned } = assignModels(samplePlan(), catalog, STRATEGY_PRESETS.balanced);
    expect(unassigned).toEqual([]);
    for (const agent of plan.agents) {
      expect(agent.model?.provider).toBe('anthropic');
      expect(agent.modelRationale).toBeTruthy();
    }
  });

  it('keeps a manual choice that is still available', () => {
    const manual = samplePlan();
    manual.agents[0] = {
      ...manual.agents[0]!,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5' },
    };
    const { plan } = assignModels(manual, catalog, STRATEGY_PRESETS.quality, true);
    expect(plan.agents[0]?.model?.id).toBe('claude-haiku-5-5');
  });

  it('reports agents nothing can serve', () => {
    expect(assignModels(samplePlan(), [], STRATEGY_PRESETS.balanced).unassigned).toHaveLength(4);
  });
});
