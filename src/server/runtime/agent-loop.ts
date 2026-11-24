import type { ChatMessage, ChatProvider, Effort, Part, Usage } from '../../providers/types.ts';
import { textOf, toolCallsOf } from '../../providers/types.ts';
import { type ToolContext, type ToolDef, type ToolOutcome, toSpec } from './tools.ts';
import { WorkspaceError } from './workspace.ts';

export interface LoopOptions {
  provider: ChatProvider;
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  tools: ToolDef[];
  context: ToolContext;
  maxTurns: number;
  signal: AbortSignal;
  /** Awaited before every model call; the orchestrator holds agents here while paused. */
  beforeCall?: () => Promise<void>;
  /** Messages other agents sent, delivered with the next tool results. */
  takeInbox(): { from: string; text: string }[];
  onUsage(usage: Usage): void;
  onThought(text: string): void;
  onTool(name: string, summary: string, ok: boolean): void;
}

export type LoopResult =
  | { kind: 'complete'; summary: string; files: string[] }
  | { kind: 'review'; verdict: 'approve' | 'request_changes'; notes: string };

export class LoopError extends Error {}

const MAX_RESULT = 30_000;

/**
 * One agent working on one task: call the model, run the tools it asks for, feed the results
 * back, until it calls complete_task (or submit_review) or runs out of turns.
 */
export async function runAgentLoop(options: LoopOptions): Promise<LoopResult> {
  const byName = new Map(options.tools.map((t) => [t.name, t]));
  const specs = options.tools.map(toSpec);
  const messages: ChatMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: options.prompt }] },
  ];
  let nudges = 0;

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    await options.beforeCall?.();
    if (options.signal.aborted) throw new LoopError('cancelled');
    const result = await options.provider.chat({
      model: options.model,
      system: options.system,
      messages,
      tools: specs,
      maxTokens: 16_000,
      effort: options.effort,
      signal: options.signal,
    });
    options.onUsage(result.usage);
    messages.push(result.message);

    const thought = textOf(result.message);
    if (thought) options.onThought(thought.slice(0, 600));
    if (result.stop === 'refusal') throw new LoopError('the model declined to continue this task');

    const calls = toolCallsOf(result.message);
    if (calls.length === 0) {
      if (++nudges > 2) throw new LoopError('the agent stopped without completing the task');
      messages.push({
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Continue the task with the tools. When it is finished, call complete_task (or submit_review when reviewing).',
          },
        ],
      });
      continue;
    }

    const results: Part[] = [];
    let finished: LoopResult | undefined;
    for (const call of calls) {
      let outcome: ToolOutcome;
      const def = byName.get(call.name);
      if (result.stop === 'max_tokens') {
        // The arguments may be cut off; never act on them.
        outcome = {
          content:
            'Your output was cut off before this call was complete. Retry with smaller steps (for example, write large files in parts).',
          isError: true,
        };
      } else if (!def) {
        outcome = { content: `Unknown tool "${call.name}".`, isError: true };
      } else {
        const parsed = def.schema.safeParse(call.input);
        if (!parsed.success) {
          outcome = {
            content: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`,
            isError: true,
          };
        } else {
          try {
            outcome = await def.run(parsed.data, options.context);
          } catch (error) {
            if (error instanceof WorkspaceError || error instanceof ToolRefusal) {
              outcome = { content: error.message, isError: true };
            } else if (options.signal.aborted) {
              throw new LoopError('cancelled');
            } else {
              outcome = {
                content: `The tool failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
              };
            }
          }
          options.onTool(call.name, def.summarize(parsed.data), !outcome.isError);
        }
      }
      if (outcome.isError && def === undefined) options.onTool(call.name, outcome.content, false);
      if (outcome.complete) finished = { kind: 'complete', ...outcome.complete };
      if (outcome.review) finished = { kind: 'review', ...outcome.review };
      results.push({
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        content:
          outcome.content.length > MAX_RESULT
            ? `${outcome.content.slice(0, MAX_RESULT)}\n[truncated]`
            : outcome.content,
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    if (finished) return finished;

    const inbox = options.takeInbox();
    if (inbox.length > 0) {
      results.push({
        type: 'text',
        text: `New messages from your team:\n${inbox.map((m) => `From ${m.from}: ${m.text}`).join('\n\n')}`,
      });
    }
    messages.push({ role: 'user', parts: results });
  }
  throw new LoopError(`no result after ${options.maxTurns} turns`);
}

/** Thrown by tool context methods to tell the agent "no" without failing the task. */
export class ToolRefusal extends Error {}
