import { z } from 'zod';

/**
 * An orchestration plan: the layers a project needs, the agents that work in them, the tasks
 * they perform with their dependencies, and who talks to whom. Plans are produced by the planner
 * model, edited by the user, and executed by the runtime.
 */

const id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/, 'ids are lower-case letters, digits, "-" or "_"');

/** Capabilities a role needs, each from 1 (barely) to 5 (critical). */
export const RequirementsSchema = z.object({
  reasoning: z.number().int().min(1).max(5),
  coding: z.number().int().min(1).max(5),
  speed: z.number().int().min(1).max(5),
  context: z.number().int().min(1).max(5),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** Permissions an agent can be granted. Each unlocks a group of runtime tools. */
export const PERMISSIONS = ['read_files', 'write_files', 'run_commands', 'message_agents'] as const;
export const PermissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof PermissionSchema>;

export const ModelRefSchema = z.object({ provider: z.string().min(1), id: z.string().min(1) });
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const LayerSchema = z.object({
  id,
  name: z.string().min(1),
  purpose: z.string().min(1),
});
export type Layer = z.infer<typeof LayerSchema>;

export const AgentSchema = z.object({
  id,
  name: z.string().min(1),
  role: z.string().min(1),
  layer: id,
  /** Set for a subagent: the agent that delegates to it and reviews its work. */
  parent: id.optional(),
  responsibilities: z.array(z.string().min(1)).min(1),
  instructions: z.string(),
  permissions: z.array(PermissionSchema),
  requirements: RequirementsSchema,
  /** Filled in by model selection; the user may override it. */
  model: ModelRefSchema.optional(),
  modelRationale: z.string().optional(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const TaskSchema = z.object({
  id,
  title: z.string().min(1),
  description: z.string().min(1),
  agent: id,
  dependsOn: z.array(id),
  deliverables: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
  /** Another agent that must approve the result before dependants start. */
  reviewer: id.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ChannelSchema = z.object({
  from: id,
  to: id,
  purpose: z.string().min(1),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const PlanSchema = z.object({
  summary: z.string().min(1),
  architecture: z.object({
    stack: z.array(z.string().min(1)),
    notes: z.string(),
  }),
  layers: z.array(LayerSchema).min(1),
  agents: z.array(AgentSchema).min(1),
  tasks: z.array(TaskSchema).min(1),
  channels: z.array(ChannelSchema),
  risks: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

export interface PlanIssue {
  path: string;
  message: string;
}

/**
 * Checks what a schema cannot: unique ids, references that resolve, a dependency graph without
 * cycles, reviewers who are not the task's own agent. Returns every issue, so a planner can be
 * asked to fix them all at once.
 */
export function validatePlan(input: unknown): { plan?: Plan; issues: PlanIssue[] } {
  const parsed = PlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }
  const plan = parsed.data;
  const issues: PlanIssue[] = [];
  const layerIds = unique(plan.layers, 'layers', issues);
  const agentIds = unique(plan.agents, 'agents', issues);
  const taskIds = unique(plan.tasks, 'tasks', issues);

  plan.agents.forEach((agent, i) => {
    if (!layerIds.has(agent.layer)) {
      issues.push({ path: `agents.${i}.layer`, message: `unknown layer "${agent.layer}"` });
    }
    if (agent.parent !== undefined && !agentIds.has(agent.parent)) {
      issues.push({ path: `agents.${i}.parent`, message: `unknown agent "${agent.parent}"` });
    }
    if (agent.parent === agent.id) {
      issues.push({ path: `agents.${i}.parent`, message: 'an agent cannot be its own parent' });
    }
  });
  plan.tasks.forEach((task, i) => {
    if (!agentIds.has(task.agent)) {
      issues.push({ path: `tasks.${i}.agent`, message: `unknown agent "${task.agent}"` });
    }
    if (task.reviewer !== undefined) {
      if (!agentIds.has(task.reviewer)) {
        issues.push({ path: `tasks.${i}.reviewer`, message: `unknown agent "${task.reviewer}"` });
      } else if (task.reviewer === task.agent) {
        issues.push({
          path: `tasks.${i}.reviewer`,
          message: 'a task cannot be reviewed by its own agent',
        });
      }
    }
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        issues.push({ path: `tasks.${i}.dependsOn`, message: `unknown task "${dep}"` });
      }
    }
  });
  plan.channels.forEach((channel, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!agentIds.has(channel[end])) {
        issues.push({ path: `channels.${i}.${end}`, message: `unknown agent "${channel[end]}"` });
      }
    }
  });
  const cycle = findCycle(plan.tasks);
  if (cycle) issues.push({ path: 'tasks', message: `dependency cycle: ${cycle.join(' -> ')}` });

  return issues.length ? { issues } : { plan, issues };
}

/**
 * Groups tasks into waves: every task in a wave depends only on tasks in earlier waves, so all
 * tasks of a wave can run in parallel. Assumes the graph has no cycles.
 */
export function executionWaves(tasks: readonly Task[]): Task[][] {
  const waves: Task[][] = [];
  const done = new Set<string>();
  let remaining = [...tasks];
  while (remaining.length > 0) {
    const ready = remaining.filter((task) => task.dependsOn.every((dep) => done.has(dep)));
    if (ready.length === 0) throw new Error('the task graph has a cycle');
    waves.push(ready);
    for (const task of ready) done.add(task.id);
    remaining = remaining.filter((task) => !done.has(task.id));
  }
  return waves;
}

/** The longest chain of dependent tasks, which bounds how fast the plan can finish. */
export function criticalPath(tasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const memo = new Map<string, string[]>();
  const longest = (taskId: string): string[] => {
    const cached = memo.get(taskId);
    if (cached) return cached;
    const task = byId.get(taskId);
    let best: string[] = [];
    for (const dep of task?.dependsOn ?? []) {
      const path = longest(dep);
      if (path.length > best.length) best = path;
    }
    const result = [...best, taskId];
    memo.set(taskId, result);
    return result;
  };
  let best: string[] = [];
  for (const task of tasks) {
    const path = longest(task.id);
    if (path.length > best.length) best = path;
  }
  return best;
}

function findCycle(tasks: readonly Task[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (taskId: string): string[] | undefined => {
    const current = state.get(taskId);
    if (current === 'done') return undefined;
    if (current === 'visiting') return [...stack.slice(stack.indexOf(taskId)), taskId];
    state.set(taskId, 'visiting');
    stack.push(taskId);
    for (const dep of byId.get(taskId)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(taskId, 'done');
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
}

function unique(items: readonly { id: string }[], path: string, issues: PlanIssue[]): Set<string> {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) {
      issues.push({ path: `${path}.${i}.id`, message: `duplicate id "${item.id}"` });
    }
    seen.add(item.id);
  });
  return seen;
}
