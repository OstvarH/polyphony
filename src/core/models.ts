import { z } from 'zod';
import type { ModelRef, Requirements } from './plan.ts';

/**
 * What the orchestrator knows about a model. Ratings are 1 to 5 and are editable by the user:
 * nothing about model preference is hard-coded into the selection logic.
 */
export const ModelInfoSchema = z.object({
  provider: z.string().min(1),
  id: z.string().min(1),
  label: z.string().min(1),
  reasoning: z.number().int().min(1).max(5),
  coding: z.number().int().min(1).max(5),
  speed: z.number().int().min(1).max(5),
  contextWindow: z.number().int().positive(),
  /** USD per million tokens. Null when unknown: cost is then reported as unknown. */
  inputPrice: z.number().nonnegative().nullable(),
  outputPrice: z.number().nonnegative().nullable(),
  toolCalling: z.boolean(),
  enabled: z.boolean(),
  /** Where the ratings came from: a curated default, a name-based guess, or the user. */
  source: z.enum(['catalog', 'heuristic', 'user']),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const StrategySchema = z.object({
  name: z.string().min(1),
  /** How much each factor counts. They are normalised, so only their ratios matter. */
  weights: z.object({
    capability: z.number().min(0),
    cost: z.number().min(0),
    speed: z.number().min(0),
  }),
  /** Penalise models far stronger than a role needs (pay less for routine work). */
  avoidOverkill: z.boolean(),
});
export type Strategy = z.infer<typeof StrategySchema>;

export const STRATEGY_PRESETS: Record<'quality' | 'balanced' | 'economy', Strategy> = {
  quality: {
    name: 'Quality first',
    weights: { capability: 0.8, cost: 0.1, speed: 0.1 },
    avoidOverkill: false,
  },
  balanced: {
    name: 'Balanced',
    weights: { capability: 0.55, cost: 0.3, speed: 0.15 },
    avoidOverkill: true,
  },
  economy: {
    name: 'Economy',
    weights: { capability: 0.35, cost: 0.5, speed: 0.15 },
    avoidOverkill: true,
  },
};

/** Curated defaults. Users add or re-rate models in Settings; other providers are discovered live. */
export const DEFAULT_CATALOG: ModelInfo[] = [
  anthropic('claude-fable-5-2', 'Claude Fable 5.2', [5, 5, 2], 1_000_000, 8, 40),
  anthropic('claude-opus-5-5', 'Claude Opus 5.5', [5, 5, 3], 1_000_000, 4, 20),
  anthropic('claude-sonnet-5-5', 'Claude Sonnet 5.5', [4, 5, 4], 1_000_000, 2, 10),
  anthropic('claude-haiku-5-5', 'Claude Haiku 5.5', [3, 3, 5], 1_000_000, 0.1, 0.5),
  {
    provider: 'mock',
    id: 'mock-model',
    label: 'Mock model (offline demo)',
    reasoning: 3,
    coding: 3,
    speed: 5,
    contextWindow: 200_000,
    inputPrice: 0,
    outputPrice: 0,
    toolCalling: true,
    enabled: true,
    source: 'catalog',
  },
];

/**
 * Ratings for a model the catalog does not know, guessed from its name. They are marked
 * "heuristic" in the UI so the user knows to check them.
 */
export function guessModelInfo(provider: string, id: string, label = id): ModelInfo {
  // Match whole name parts, so "gemini" is not mistaken for "mini".
  const parts = id.toLowerCase().split(/[^a-z0-9]+/);
  const size = (part: string) => (/^\d+b$/.test(part) ? Number.parseInt(part, 10) : undefined);
  const SMALL = new Set(['mini', 'nano', 'lite', 'flash', 'haiku', 'small', 'tiny']);
  const LARGE = new Set(['opus', 'ultra', 'pro', 'large', 'o1', 'o3', 'o4', 'fable', 'reasoner']);
  let ratings: [number, number, number] = [4, 4, 3];
  if (parts.some((p) => SMALL.has(p) || (size(p) ?? 99) <= 14)) ratings = [3, 3, 5];
  else if (parts.some((p) => LARGE.has(p) || (size(p) ?? 0) >= 65)) ratings = [5, 5, 2];
  return {
    provider,
    id,
    label,
    reasoning: ratings[0],
    coding: ratings[1],
    speed: ratings[2],
    contextWindow: 128_000,
    inputPrice: null,
    outputPrice: null,
    toolCalling: true,
    enabled: true,
    source: 'heuristic',
  };
}

export interface Selection {
  model: ModelRef;
  score: number;
  rationale: string;
  alternatives: { model: ModelRef; score: number }[];
}

const CONTEXT_NEEDS = [0, 16_000, 64_000, 128_000, 200_000, 500_000];

/**
 * Picks the best available model for a role. A model must support tool calling and have enough
 * context; among those, the score weighs how well its ratings meet the requirements, its price
 * and its speed, by the strategy's weights. Returns undefined when nothing qualifies.
 */
export function selectModel(
  requirements: Requirements,
  candidates: readonly ModelInfo[],
  strategy: Strategy,
): Selection | undefined {
  const minContext = CONTEXT_NEEDS[requirements.context] ?? 0;
  const eligible = candidates.filter(
    (m) => m.enabled && m.toolCalling && m.contextWindow >= minContext,
  );
  if (eligible.length === 0) return undefined;

  const prices = eligible.map(blendedPrice).filter((p): p is number => p !== null);
  const cheapest = Math.min(...prices, Number.POSITIVE_INFINITY);
  const dearest = Math.max(...prices, 0);

  const total = strategy.weights.capability + strategy.weights.cost + strategy.weights.speed || 1;
  const w = {
    capability: strategy.weights.capability / total,
    cost: strategy.weights.cost / total,
    speed: strategy.weights.speed / total,
  };

  const scored = eligible
    .map((model) => {
      const capability = capabilityFit(requirements, model, strategy.avoidOverkill);
      const price = blendedPrice(model);
      // Unknown prices sit in the middle rather than winning or losing on cost.
      const cost =
        price === null || dearest <= cheapest
          ? 0.5
          : 1 - Math.log(price / cheapest + 1) / Math.log(dearest / cheapest + 1);
      // A model is penalised only for being slower than the role needs.
      const speed = 1 - Math.max(0, requirements.speed - model.speed) / 4;
      const score = w.capability * capability + w.cost * cost + w.speed * speed;
      return { model, score, capability };
    })
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));

  const best = scored[0];
  if (!best) return undefined;
  return {
    model: { provider: best.model.provider, id: best.model.id },
    score: round(best.score),
    rationale: explain(requirements, best.model, strategy),
    alternatives: scored.slice(1, 4).map((s) => ({
      model: { provider: s.model.provider, id: s.model.id },
      score: round(s.score),
    })),
  };
}

/** 1 when the model meets every requirement; shortfalls cost far more than surplus. */
function capabilityFit(req: Requirements, model: ModelInfo, avoidOverkill: boolean): number {
  let penalty = 0;
  for (const dim of ['reasoning', 'coding'] as const) {
    const gap = model[dim] - req[dim];
    if (gap < 0) penalty += -gap * 0.25;
    else if (avoidOverkill) penalty += gap * 0.06;
  }
  return Math.max(0, 1 - penalty);
}

function blendedPrice(model: ModelInfo): number | null {
  if (model.inputPrice === null || model.outputPrice === null) return null;
  // Agent loops read far more than they write.
  return (model.inputPrice * 3 + model.outputPrice) / 4;
}

function explain(req: Requirements, model: ModelInfo, strategy: Strategy): string {
  const strengths: string[] = [];
  if (model.reasoning >= req.reasoning) strengths.push(`reasoning ${model.reasoning}/5`);
  if (model.coding >= req.coding) strengths.push(`coding ${model.coding}/5`);
  if (req.speed >= 4 && model.speed >= 4) strengths.push('fast');
  const price =
    model.inputPrice === null
      ? 'price unknown'
      : `$${model.inputPrice}/$${model.outputPrice} per M tokens`;
  return `${model.label}: ${strengths.join(', ') || 'closest available fit'}; ${price}; strategy "${strategy.name}".`;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function anthropic(
  id: string,
  label: string,
  [reasoning, coding, speed]: [number, number, number],
  contextWindow: number,
  inputPrice: number,
  outputPrice: number,
): ModelInfo {
  return {
    provider: 'anthropic',
    id,
    label,
    reasoning,
    coding,
    speed,
    contextWindow,
    inputPrice,
    outputPrice,
    toolCalling: true,
    enabled: true,
    source: 'catalog',
  };
}

/** Dollar cost of a call, or null when the model's price is unknown. */
export function costOf(
  model: ModelInfo | undefined,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  if (!model || model.inputPrice === null || model.outputPrice === null) return null;
  return (usage.inputTokens * model.inputPrice + usage.outputTokens * model.outputPrice) / 1e6;
}
