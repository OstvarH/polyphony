import type { Plan } from '../core/plan.ts';
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type Part,
  type ProviderModel,
  textOf,
} from './types.ts';

/**
 * A deterministic offline provider. It plans from keywords in the description and "works" by
 * writing a short deliverable per task, so the whole platform can be tried, demoed and tested
 * without an API key or any cost.
 */
export class MockProvider implements ChatProvider {
  readonly id = 'mock';
  readonly #delayMs: number;

  constructor(options: { delayMs?: number } = {}) {
    this.#delayMs = options.delayMs ?? 700;
  }

  async listModels(): Promise<ProviderModel[]> {
    return [{ id: 'mock-model', label: 'Mock model (offline demo)' }];
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    await sleep(this.#delayMs * (0.5 + pseudoRandom(request)), request.signal);
    const tools = new Set(request.tools.map((t) => t.name));
    const last = request.messages.at(-1);
    const prompt = request.messages.map(textOf).join('\n');
    const afterTools = last?.parts.some((p) => p.type === 'tool_result') ?? false;

    let parts: Part[];
    if (tools.has('submit_plan')) {
      parts = [call('submit_plan', mockPlan(prompt))];
    } else if (tools.has('submit_review')) {
      parts = [
        call('submit_review', { verdict: 'approve', notes: 'Meets the acceptance criteria.' }),
      ];
    } else if (!afterTools && tools.has('write_file')) {
      const taskId = /Task id: ([\w-]+)/.exec(prompt)?.[1] ?? 'task';
      const title = /Task: (.+)/.exec(prompt)?.[1] ?? taskId;
      const calls: Part[] = [
        call('write_file', {
          path: `deliverables/${taskId}.md`,
          content: `# ${title}\n\nProduced by the mock model for task \`${taskId}\`.\n`,
        }),
      ];
      if (tools.has('send_message') && /Channels you can use: \S/.test(prompt)) {
        const to = /Channels you can use: ([\w-]+)/.exec(prompt)?.[1];
        if (to) calls.push(call('send_message', { to, text: `Finished a draft of ${title}.` }));
      }
      parts = [{ type: 'text', text: `Working on ${title}.` }, ...calls];
    } else {
      parts = [call('complete_task', { summary: 'Task completed by the mock model.' })];
    }
    const input = Math.round(prompt.length / 4);
    return {
      message: { role: 'assistant', parts },
      stop: parts.some((p) => p.type === 'tool_call') ? 'tool_calls' : 'end',
      usage: { inputTokens: input, outputTokens: 120 + (input % 200) },
    };
  }
}

let callCounter = 0;
function call(name: string, input: unknown): Part {
  callCounter += 1;
  return { type: 'tool_call', id: `mock_${callCounter}`, name, input };
}

function pseudoRandom(request: ChatRequest): number {
  let hash = 0;
  for (const ch of request.model + request.messages.length + request.system.length) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  }
  return hash / 997;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

/** A plausible plan derived from keywords, so the demo reflects what the user asked for. */
export function mockPlan(description: string): Plan {
  const text = description.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  const stack: string[] = [];
  if (has('laravel', 'php')) stack.push('Laravel (PHP)');
  if (has('node', 'express', 'fastify', 'typescript')) stack.push('Node.js + TypeScript');
  if (has('django', 'python', 'fastapi')) stack.push('Python');
  if (has('react')) stack.push('React');
  if (has('vue')) stack.push('Vue');
  if (has('postgres')) stack.push('PostgreSQL');
  if (has('mysql')) stack.push('MySQL');
  if (stack.length === 0) stack.push('TypeScript', 'React', 'PostgreSQL');
  const frontend = has('react', 'vue', 'frontend', 'ui', 'dashboard', 'web');
  const database = has('postgres', 'mysql', 'database', 'sql', 'accounting', 'management');

  const layers: Plan['layers'] = [
    { id: 'architecture', name: 'Architecture', purpose: 'Structure, contracts and decisions.' },
    { id: 'backend', name: 'Backend', purpose: 'Domain logic and the API.' },
  ];
  if (database) layers.push({ id: 'data', name: 'Data', purpose: 'Schema and migrations.' });
  if (frontend) layers.push({ id: 'frontend', name: 'Frontend', purpose: 'The user interface.' });
  layers.push({ id: 'quality', name: 'Quality', purpose: 'Tests, review and documentation.' });

  const agents: Plan['agents'] = [
    agent(
      'architect',
      'Solution Architect',
      'architecture',
      [5, 3, 2, 4],
      ['read_files', 'write_files', 'message_agents'],
    ),
    agent(
      'backend-dev',
      'Backend Engineer',
      'backend',
      [4, 5, 3, 3],
      ['read_files', 'write_files', 'message_agents'],
    ),
    {
      ...agent(
        'api-tester',
        'API Test Writer',
        'backend',
        [2, 3, 5, 2],
        ['read_files', 'write_files'],
      ),
      parent: 'backend-dev',
    },
  ];
  if (database) {
    agents.push(
      agent(
        'db-engineer',
        'Database Engineer',
        'data',
        [4, 4, 3, 2],
        ['read_files', 'write_files', 'message_agents'],
      ),
    );
  }
  if (frontend) {
    agents.push(
      agent(
        'frontend-dev',
        'Frontend Engineer',
        'frontend',
        [3, 5, 3, 2],
        ['read_files', 'write_files', 'message_agents'],
      ),
    );
  }
  agents.push(
    agent('reviewer', 'Code Reviewer', 'quality', [4, 4, 3, 4], ['read_files', 'message_agents']),
  );
  agents.push(
    agent(
      'tech-writer',
      'Technical Writer',
      'quality',
      [2, 1, 5, 2],
      ['read_files', 'write_files'],
    ),
  );

  const tasks: Plan['tasks'] = [
    task('architecture', 'Architecture and module plan', 'architect', []),
  ];
  if (database)
    tasks.push(
      task('schema', 'Database schema and migrations', 'db-engineer', ['architecture'], 'reviewer'),
    );
  tasks.push(
    task('api', 'Core API', 'backend-dev', database ? ['schema'] : ['architecture'], 'reviewer'),
  );
  tasks.push(task('api-tests', 'API tests', 'api-tester', ['api']));
  if (frontend)
    tasks.push(task('ui', 'User interface', 'frontend-dev', ['architecture'], 'reviewer'));
  tasks.push(
    task('docs', 'Documentation', 'tech-writer', frontend ? ['api-tests', 'ui'] : ['api-tests']),
  );

  const channels: Plan['channels'] = [
    { from: 'architect', to: 'backend-dev', purpose: 'Hand over contracts and decisions.' },
    { from: 'backend-dev', to: 'api-tester', purpose: 'Share endpoints to cover.' },
  ];
  if (frontend)
    channels.push({ from: 'backend-dev', to: 'frontend-dev', purpose: 'Agree the API contract.' });
  if (database)
    channels.push({ from: 'db-engineer', to: 'backend-dev', purpose: 'Share the schema.' });

  return {
    summary: `A ${layers.length}-layer team of ${agents.length} agents for ${
      /^# Project: (.+)$/m.exec(description)?.[1] ??
      (description.split('\n')[0]?.slice(0, 120) || 'the project')
    }, with ${tasks.length} tasks.`,
    architecture: {
      stack,
      notes: 'Generated offline by the mock model from keywords in the description.',
    },
    layers,
    agents,
    tasks,
    channels,
    risks: ['The mock model plans from keywords only. Add an API key for a real analysis.'],
  };
}

function agent(
  id: string,
  role: string,
  layer: string,
  [reasoning, coding, speed, context]: [number, number, number, number],
  permissions: Plan['agents'][number]['permissions'],
): Plan['agents'][number] {
  return {
    id,
    name: role,
    role,
    layer,
    responsibilities: [`Own the ${layer} work assigned to the ${role.toLowerCase()}.`],
    instructions: '',
    permissions,
    requirements: { reasoning, coding, speed, context },
  };
}

function task(
  id: string,
  title: string,
  agentId: string,
  dependsOn: string[],
  reviewer?: string,
): Plan['tasks'][number] {
  return {
    id,
    title,
    description: `${title}.`,
    agent: agentId,
    dependsOn,
    deliverables: [`deliverables/${id}.md`],
    acceptanceCriteria: [`${title} is complete and consistent with the architecture.`],
    ...(reviewer ? { reviewer } : {}),
  };
}
