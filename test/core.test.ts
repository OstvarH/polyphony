import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG,
  guessModelInfo,
  type ModelInfo,
  STRATEGY_PRESETS,
  selectModel,
} from '../src/core/models.ts';
import { criticalPath, executionWaves, validatePlan } from '../src/core/plan.ts';
import { samplePlan } from './fixtures.ts';

describe('validatePlan', () => {
  it('accepts a consistent plan', () => {
    const { plan, issues } = validatePlan(samplePlan());
    expect(issues).toEqual([]);
    expect(plan?.agents).toHaveLength(4);
  });

  it('reports every broken reference at once', () => {
    const plan = samplePlan();
    plan.agents[0] = { ...plan.agents[0]!, layer: 'nowhere' };
    plan.tasks[1] = { ...plan.tasks[1]!, agent: 'ghost', dependsOn: ['missing'] };
    plan.channels.push({ from: 'api-dev', to: 'nobody', purpose: 'x' });
    const { plan: valid, issues } = validatePlan(plan);
    expect(valid).toBeUndefined();
    expect(issues.map((i) => i.message)).toEqual([
      'unknown layer "nowhere"',
      'unknown agent "ghost"',
      'unknown task "missing"',
      'unknown agent "nobody"',
    ]);
  });

  it('finds dependency cycles', () => {
    const plan = samplePlan();
    plan.tasks[0] = { ...plan.tasks[0]!, dependsOn: ['docs'] };
    const { issues } = validatePlan(plan);
    expect(issues).toEqual([
      { path: 'tasks', message: 'dependency cycle: design -> docs -> api -> design' },
    ]);
  });

  it('rejects duplicate ids and self-review', () => {
    const plan = samplePlan();
    plan.tasks.push({ ...plan.tasks[0]! });
    plan.tasks[1] = { ...plan.tasks[1]!, reviewer: 'api-dev' };
    const messages = validatePlan(plan).issues.map((i) => i.message);
    expect(messages).toContain('duplicate id "design"');
    expect(messages).toContain('a task cannot be reviewed by its own agent');
  });

  it('reports schema problems with their path', () => {
    const { issues } = validatePlan({ ...samplePlan(), agents: [] });
    expect(issues[0]?.path).toBe('agents');
  });
});

describe('execution order', () => {
  it('groups independent tasks into parallel waves', () => {
    const waves = executionWaves(samplePlan().tasks).map((wave) => wave.map((t) => t.id));
    expect(waves).toEqual([['design'], ['api', 'tests'], ['docs']]);
  });

  it('finds the critical path', () => {
    expect(criticalPath(samplePlan().tasks)).toEqual(['design', 'api', 'docs']);
  });
});

describe('selectModel', () => {
  const real = DEFAULT_CATALOG.filter((m) => m.provider !== 'mock');
  const hard = { reasoning: 5, coding: 5, speed: 2, context: 3 };
  const routine = { reasoning: 2, coding: 2, speed: 5, context: 1 };

  it('gives hard reasoning work to a frontier model', () => {
    const pick = selectModel(hard, real, STRATEGY_PRESETS.balanced);
    expect(pick?.model.id).toMatch(/opus|fable/);
    expect(pick?.rationale).toContain('reasoning 5/5');
  });

  it('gives routine fast work to a small model', () => {
    const pick = selectModel(routine, real, STRATEGY_PRESETS.balanced);
    expect(pick?.model.id).toBe('claude-haiku-5-5');
  });

  it('follows the strategy, not a fixed preference', () => {
    const mid = { reasoning: 4, coding: 4, speed: 3, context: 2 };
    const quality = selectModel(mid, real, STRATEGY_PRESETS.quality)?.model.id;
    const economy = selectModel(mid, real, STRATEGY_PRESETS.economy)?.model.id;
    expect(quality).not.toBe(economy);
  });

  it('only considers enabled, tool-calling models with enough context', () => {
    const models: ModelInfo[] = [
      { ...real[0]!, id: 'off', enabled: false },
      { ...real[0]!, id: 'no-tools', toolCalling: false },
      { ...real[0]!, id: 'small-ctx', contextWindow: 8_000 },
    ];
    expect(selectModel({ ...hard, context: 5 }, models, STRATEGY_PRESETS.quality)).toBeUndefined();
  });

  it('returns ranked alternatives', () => {
    const pick = selectModel(hard, real, STRATEGY_PRESETS.balanced);
    expect(pick?.alternatives.length).toBeGreaterThan(0);
    for (const alt of pick?.alternatives ?? []) expect(alt.score).toBeLessThanOrEqual(pick!.score);
  });
});

describe('guessModelInfo', () => {
  it('rates unknown models by their name and marks them as guesses', () => {
    expect(guessModelInfo('openai', 'gpt-x-mini').speed).toBe(5);
    expect(guessModelInfo('google', 'gemini-pro-latest').reasoning).toBe(5);
    expect(guessModelInfo('ollama', 'llama-70b').source).toBe('heuristic');
    expect(guessModelInfo('ollama', 'llama-70b').inputPrice).toBeNull();
  });
});
