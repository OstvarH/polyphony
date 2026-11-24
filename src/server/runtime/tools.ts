import { z } from 'zod';
import type { Agent, Permission, Task } from '../../core/plan.ts';
import type { ToolSpec } from '../../providers/types.ts';
import type { Workspace } from './workspace.ts';

/** What tools can do, provided by the orchestrator so it sees every effect. */
export interface ToolContext {
  agent: Agent;
  task: Task;
  workspace: Workspace;
  /** Agents this agent may message. */
  contacts: string[];
  sharedContext(): string;
  writeFile(path: string, content: string): string;
  editFile(path: string, find: string, replace: string): string;
  sendMessage(to: string, text: string): void;
  readMessages(): { from: string; text: string }[];
  escalate(question: string): Promise<string>;
  runCommand(command: string, timeoutSeconds: number): Promise<string>;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** Set by complete_task: the agent is done with the task. */
  complete?: { summary: string; files: string[] };
  /** Set by submit_review. */
  review?: { verdict: 'approve' | 'request_changes'; notes: string };
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Which permission unlocks it; "always" for every agent, "review" only while reviewing. */
  access: Permission | 'always' | 'work' | 'review';
  /** One line for the dashboard. */
  summarize(input: z.infer<S>): string;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

const ok = (content: string): ToolOutcome => ({ content });

export const TOOLS: ToolDef[] = [
  tool({
    name: 'list_files',
    description: 'List files and folders in the workspace (folders end with "/").',
    schema: z.object({
      path: z.string().optional(),
      depth: z.number().int().min(1).max(5).optional(),
    }),
    access: 'read_files',
    summarize: (i) => i.path ?? '.',
    run: async (i, ctx) =>
      ok(ctx.workspace.list(i.path ?? '.', i.depth ?? 2).join('\n') || '(empty)'),
  }),
  tool({
    name: 'read_file',
    description:
      'Read a text file from the workspace. Large files are returned in pages; pass offset to continue.',
    schema: z.object({ path: z.string(), offset: z.number().int().min(0).optional() }),
    access: 'read_files',
    summarize: (i) => i.path,
    run: async (i, ctx) => ok(ctx.workspace.read(i.path, i.offset ?? 0)),
  }),
  tool({
    name: 'search_files',
    description: 'Find lines containing a text (case-insensitive) across the workspace.',
    schema: z.object({ query: z.string().min(1), path: z.string().optional() }),
    access: 'read_files',
    summarize: (i) => `"${i.query}"`,
    run: async (i, ctx) =>
      ok(ctx.workspace.search(i.query, i.path ?? '.').join('\n') || 'No matches.'),
  }),
  tool({
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the complete content.',
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    access: 'write_files',
    summarize: (i) => `${i.path} (${i.content.length} chars)`,
    run: async (i, ctx) => ok(`Wrote ${ctx.writeFile(i.path, i.content)}.`),
  }),
  tool({
    name: 'edit_file',
    description:
      'Replace one exact, unique piece of text in a file. Prefer this to rewriting large files.',
    schema: z.object({ path: z.string().min(1), find: z.string().min(1), replace: z.string() }),
    access: 'write_files',
    summarize: (i) => i.path,
    run: async (i, ctx) => ok(`Edited ${ctx.editFile(i.path, i.find, i.replace)}.`),
  }),
  tool({
    name: 'run_command',
    description:
      'Run a shell command in the workspace (builds, tests, linters). The user must approve each command; output is truncated.',
    schema: z.object({
      command: z.string().min(1).max(2000),
      timeoutSeconds: z.number().int().min(1).max(600).optional(),
    }),
    access: 'run_commands',
    summarize: (i) => i.command,
    run: async (i, ctx) => ok(await ctx.runCommand(i.command, i.timeoutSeconds ?? 120)),
  }),
  tool({
    name: 'send_message',
    description:
      'Send a message to another agent (by id) or to everyone ("*"). Use it to agree contracts and hand over decisions.',
    schema: z.object({ to: z.string().min(1), text: z.string().min(1).max(4000) }),
    access: 'message_agents',
    summarize: (i) => `to ${i.to}`,
    run: async (i, ctx) => {
      if (i.to !== '*' && !ctx.contacts.includes(i.to)) {
        return {
          content: `Unknown agent "${i.to}". You can message: ${ctx.contacts.join(', ') || 'nobody'}.`,
          isError: true,
        };
      }
      ctx.sendMessage(i.to, i.text);
      return ok('Sent.');
    },
  }),
  tool({
    name: 'read_messages',
    description: 'Read messages other agents sent you that you have not seen yet.',
    schema: z.object({}),
    access: 'message_agents',
    summarize: () => 'inbox',
    run: async (_i, ctx) => {
      const messages = ctx.readMessages();
      return ok(
        messages.length
          ? messages.map((m) => `From ${m.from}: ${m.text}`).join('\n\n')
          : 'No new messages.',
      );
    },
  }),
  tool({
    name: 'read_shared_context',
    description:
      'Read the shared project context: the brief, the team, and the results of finished tasks.',
    schema: z.object({}),
    access: 'always',
    summarize: () => 'shared context',
    run: async (_i, ctx) => ok(ctx.sharedContext()),
  }),
  tool({
    name: 'escalate',
    description:
      'Ask the human operator to decide something you cannot decide yourself (missing requirement, conflicting instructions). Work pauses until they answer.',
    schema: z.object({ question: z.string().min(1).max(2000) }),
    access: 'always',
    summarize: (i) => i.question.slice(0, 120),
    run: async (i, ctx) => ok(`The operator answered: ${await ctx.escalate(i.question)}`),
  }),
  tool({
    name: 'complete_task',
    description:
      'Finish the task. Summarise what you did and list the files you produced. Call it once, last.',
    schema: z.object({
      summary: z.string().min(1).max(4000),
      files: z.array(z.string()).optional(),
    }),
    access: 'work',
    summarize: (i) => i.summary.slice(0, 120),
    run: async (i) => ({
      content: 'Task completed.',
      complete: { summary: i.summary, files: i.files ?? [] },
    }),
  }),
  tool({
    name: 'submit_review',
    description: 'Submit your review: approve, or request changes with specific, actionable notes.',
    schema: z.object({
      verdict: z.enum(['approve', 'request_changes']),
      notes: z.string().min(1).max(4000),
    }),
    access: 'review',
    summarize: (i) => i.verdict,
    run: async (i) => ({ content: 'Review submitted.', review: i }),
  }),
];

export function toolsFor(agent: Agent, mode: 'work' | 'review'): ToolDef[] {
  const granted = new Set<string>(agent.permissions);
  return TOOLS.filter((t) => {
    if (t.access === 'always') return true;
    if (t.access === 'work' || t.access === 'review') return t.access === mode;
    // Reviewers read but never write or run anything.
    if (mode === 'review') return t.access === 'read_files' && granted.has('read_files');
    return granted.has(t.access);
  });
}

export function toSpec(def: ToolDef): ToolSpec {
  const parameters = z.toJSONSchema(def.schema) as Record<string, unknown>;
  delete parameters.$schema;
  return { name: def.name, description: def.description, parameters };
}
