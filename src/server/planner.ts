import { z } from 'zod';
import {
  costOf,
  type ModelInfo,
  type Selection,
  type Strategy,
  selectModel,
} from '../core/models.ts';
import { type Plan, PlanSchema, type Requirements, validatePlan } from '../core/plan.ts';
import type { ChatMessage, ChatProvider, Usage } from '../providers/types.ts';
import { toolCallsOf } from '../providers/types.ts';
import { describeAnalysis, type RepoAnalysis } from './analyzer.ts';
import type { ProjectInput } from './store.ts';

/** What the architect role needs from a model. */
export const PLANNER_REQUIREMENTS: Requirements = { reasoning: 5, coding: 3, speed: 2, context: 4 };

const SYSTEM = `You are the orchestration architect of a multi-agent software development platform.
Given a project, you design the team of AI agents that will build it and the work they will do.
You do not write the software yourself. You submit your design by calling the submit_plan tool exactly once.

How to design the plan:
- Decide which layers this project actually needs (for example architecture, backend, frontend, data, integrations, quality, security, documentation, deployment). Do not add layers the project does not need, and do not force a fixed template.
- Create agents with one clear role each. Give an agent subagents (parent = the delegating agent) only when part of its work is separable, lighter and benefits from a cheaper or faster model.
- Rate each agent's requirements honestly from 1 to 5: reasoning (design, ambiguity, trade-offs), coding (amount and difficulty of code), speed (how much latency matters), context (how much code or documentation it must hold at once). The platform picks each agent's model from these ratings, so inflated ratings waste money and deflated ratings hurt quality.
- Grant least privilege: read_files, write_files, run_commands (only for agents that must run builds or tests), message_agents (only for agents that coordinate).
- Split the work into tasks that one agent can finish in one focused session. Each task names its agent, the tasks it truly depends on, concrete deliverables (file paths where possible) and checkable acceptance criteria.
- Maximise safe parallelism: only add a dependency when a task needs another task's output.
- Add a reviewer (a different agent) to tasks where a mistake would be costly: architecture, data models, security, public APIs.
- Add channels between agents that must agree on something (an API contract, a schema), so they can talk directly instead of going through the orchestrator.
- List the main risks.
- Ids are lower-case letters, digits, "-" or "_". Keep the plan focused: usually 3 to 10 agents and 5 to 25 tasks.`;

export interface PlannerResult {
  plan: Plan;
  model: string;
  usage: Usage;
  cost: number | null;
  attempts: number;
}

export class PlannerError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'PlannerError';
    this.issues = issues;
  }
}

/** The submit_plan tool, with the plan's JSON Schema. Model choice is not the planner's job. */
export function planToolSchema(): Record<string, unknown> {
  const PlannerPlan = PlanSchema.extend({
    agents: z
      .array(PlanSchema.shape.agents.element.omit({ model: true, modelRationale: true }))
      .min(1),
  });
  const schema = z.toJSONSchema(PlannerPlan) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export function plannerPrompt(
  project: ProjectInput,
  analysis: RepoAnalysis | null,
  models: readonly ModelInfo[],
): string {
  const list = (items: string[]) =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none given)';
  return [
    `# Project: ${project.name}`,
    '',
    project.description,
    '',
    '## Preferred stack',
    list(project.stack),
    '',
    '## Rules, constraints and standards',
    project.instructions.trim() || '(none given)',
    '',
    '## Expected deliverables',
    list(project.deliverables),
    '',
    '## Acceptance criteria',
    list(project.acceptanceCriteria),
    '',
    '## Repository',
    project.repository ? `Linked repository: ${project.repository}` : 'No linked repository.',
    analysis ? describeAnalysis(analysis) : 'No workspace analysis.',
    '',
    '## Models available to the team (for calibration; the platform assigns them)',
    ...models
      .filter((m) => m.enabled)
      .map(
        (m) => `- ${m.label}: reasoning ${m.reasoning}/5, coding ${m.coding}/5, speed ${m.speed}/5`,
      ),
    '',
    'Design the orchestration plan and call submit_plan.',
  ].join('\n');
}

/**
 * Asks the planner model for a plan and validates it. Invalid plans are sent back with the list
 * of problems, up to `maxAttempts` times, so the model can repair its own output.
 */
export async function generatePlan(options: {
  provider: ChatProvider;
  model: ModelInfo;
  project: ProjectInput;
  analysis: RepoAnalysis | null;
  catalog: readonly ModelInfo[];
  maxAttempts?: number;
  signal?: AbortSignal;
}): Promise<PlannerResult> {
  const tool = {
    name: 'submit_plan',
    description: 'Submit the complete orchestration plan.',
    parameters: planToolSchema(),
  };
  const messages: ChatMessage[] = [
    {
      role: 'user',
      parts: [
        { type: 'text', text: plannerPrompt(options.project, options.analysis, options.catalog) },
      ],
    },
  ];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const maxAttempts = options.maxAttempts ?? 3;
  let lastIssues: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await options.provider.chat({
      model: options.model.id,
      system: SYSTEM,
      messages,
      tools: [tool],
      maxTokens: 32_000,
      effort: 'high',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    messages.push(result.message);

    if (result.stop === 'refusal')
      throw new PlannerError('The planner model declined the request.');
    const submit = toolCallsOf(result.message).find((c) => c.name === 'submit_plan');
    if (!submit) {
      lastIssues = ['submit_plan was not called'];
      messages.push({
        role: 'user',
        parts: [{ type: 'text', text: 'Submit the plan by calling the submit_plan tool.' }],
      });
      continue;
    }
    if (result.stop === 'max_tokens') {
      lastIssues = ['the plan was cut off at the output limit'];
      messages.push({
        role: 'user',
        parts: [
          {
            type: 'tool_result',
            callId: submit.id,
            name: submit.name,
            isError: true,
            content: 'The plan was cut off. Submit a more compact plan.',
          },
        ],
      });
      continue;
    }
    const { plan, issues } = validatePlan(submit.input);
    if (plan) {
      return {
        plan,
        model: options.model.id,
        usage,
        cost: costOf(options.model, usage),
        attempts: attempt,
      };
    }
    lastIssues = issues.map((i) => `${i.path || '(root)'}: ${i.message}`);
    messages.push({
      role: 'user',
      parts: [
        {
          type: 'tool_result',
          callId: submit.id,
          name: submit.name,
          isError: true,
          content: `The plan is invalid. Fix every issue and call submit_plan again:\n${lastIssues.join('\n')}`,
        },
      ],
    });
  }
  throw new PlannerError(`No valid plan after ${maxAttempts} attempts.`, lastIssues);
}

/**
 * Gives every agent a model from the available catalog. An agent whose current model is still
 * available keeps it when `keepExisting` is set, so the user's manual choices survive.
 */
export function assignModels(
  plan: Plan,
  catalog: readonly ModelInfo[],
  strategy: Strategy,
  keepExisting = false,
): { plan: Plan; unassigned: string[] } {
  const available = (ref: { provider: string; id: string } | undefined) =>
    ref && catalog.some((m) => m.enabled && m.provider === ref.provider && m.id === ref.id);
  const unassigned: string[] = [];
  const agents = plan.agents.map((agent) => {
    if (keepExisting && available(agent.model)) return agent;
    const selection: Selection | undefined = selectModel(agent.requirements, catalog, strategy);
    if (!selection) {
      unassigned.push(agent.id);
      const { model: _model, modelRationale: _rationale, ...rest } = agent;
      return rest;
    }
    return { ...agent, model: selection.model, modelRationale: selection.rationale };
  });
  return { plan: { ...plan, agents }, unassigned };
}
