import { describe, expect, it } from 'vitest';
import { validatePlan } from '../src/core/plan.ts';
import { toAnthropic } from '../src/providers/anthropic.ts';
import { toGemini } from '../src/providers/gemini.ts';
import { MockProvider, mockPlan } from '../src/providers/mock.ts';
import { toOpenAI } from '../src/providers/openai.ts';
import { type ChatMessage, toolCallsOf } from '../src/providers/types.ts';

const assistantTurn: ChatMessage = {
  role: 'assistant',
  parts: [
    { type: 'text', text: 'Reading the file.' },
    { type: 'tool_call', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
  ],
};
const toolResults: ChatMessage = {
  role: 'user',
  parts: [
    { type: 'tool_result', callId: 'c1', name: 'read_file', content: 'export {}' },
    { type: 'text', text: 'Continue.' },
  ],
};

describe('message conversion', () => {
  it('maps to Anthropic content blocks', () => {
    expect(toAnthropic(assistantTurn)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading the file.' },
        { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    });
    expect(toAnthropic(toolResults).content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'export {}' },
      { type: 'text', text: 'Continue.' },
    ]);
  });

  it('replays native Anthropic content unchanged', () => {
    const native = [{ type: 'thinking', thinking: '', signature: 'sig' }];
    const message: ChatMessage = {
      ...assistantTurn,
      native: { provider: 'anthropic', content: native },
    };
    expect(toAnthropic(message).content).toBe(native);
  });

  it('maps to OpenAI messages with tool results first', () => {
    expect(toOpenAI(assistantTurn)).toEqual([
      {
        role: 'assistant',
        content: 'Reading the file.',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
    ]);
    expect(toOpenAI(toolResults)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'export {}' },
      { role: 'user', content: 'Continue.' },
    ]);
  });

  it('maps to Gemini function calls and responses', () => {
    expect(toGemini(assistantTurn)).toEqual({
      role: 'model',
      parts: [
        { text: 'Reading the file.' },
        { functionCall: { id: 'c1', name: 'read_file', args: { path: 'a.ts' } } },
      ],
    });
    expect(toGemini(toolResults).parts?.[0]).toEqual({
      functionResponse: { id: 'c1', name: 'read_file', response: { output: 'export {}' } },
    });
  });
});

describe('MockProvider', () => {
  const provider = new MockProvider({ delayMs: 0 });
  const plannerTool = { name: 'submit_plan', description: '', parameters: {} };

  it('plans from the description and the plan is valid', async () => {
    const result = await provider.chat({
      model: 'mock-model',
      system: '',
      maxTokens: 1000,
      tools: [plannerTool],
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Laravel and React brokerage app with PostgreSQL' }],
        },
      ],
    });
    const [submit] = toolCallsOf(result.message);
    const { plan, issues } = validatePlan(submit?.input);
    expect(issues).toEqual([]);
    expect(plan?.architecture.stack).toEqual(['Laravel (PHP)', 'React', 'PostgreSQL']);
    expect(plan?.layers.map((l) => l.id)).toContain('frontend');
  });

  it('writes a deliverable, then completes the task', async () => {
    const tools = ['write_file', 'complete_task'].map((name) => ({
      name,
      description: '',
      parameters: {},
    }));
    const first = await provider.chat({
      model: 'mock-model',
      system: '',
      maxTokens: 1000,
      tools,
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Task id: api\nTask: Core API' }] }],
    });
    expect(toolCallsOf(first.message).map((c) => c.name)).toEqual(['write_file']);
    const second = await provider.chat({
      model: 'mock-model',
      system: '',
      maxTokens: 1000,
      tools,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Task id: api' }] },
        first.message,
        {
          role: 'user',
          parts: [{ type: 'tool_result', callId: 'x', name: 'write_file', content: 'ok' }],
        },
      ],
    });
    expect(toolCallsOf(second.message).map((c) => c.name)).toEqual(['complete_task']);
  });

  it('keeps plans small when the description is minimal', () => {
    const plan = mockPlan('A CLI tool');
    expect(validatePlan(plan).issues).toEqual([]);
    expect(plan.layers.map((l) => l.id)).not.toContain('frontend');
  });
});
