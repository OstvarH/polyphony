import type { Plan } from '../src/core/plan.ts';

/** A small but realistic plan: an architect, a backend agent with a subagent, and a reviewer. */
export function samplePlan(): Plan {
  return {
    summary: 'A notes API with a React client.',
    architecture: { stack: ['TypeScript', 'Fastify', 'React'], notes: 'REST API, SPA client.' },
    layers: [
      { id: 'architecture', name: 'Architecture', purpose: 'Decide structure and contracts.' },
      { id: 'backend', name: 'Backend', purpose: 'Build the API.' },
      { id: 'quality', name: 'Quality', purpose: 'Review and test.' },
    ],
    agents: [
      agent('architect', 'architecture', { reasoning: 5, coding: 3, speed: 2, context: 3 }),
      agent('api-dev', 'backend', { reasoning: 3, coding: 5, speed: 3, context: 2 }),
      {
        ...agent('test-writer', 'backend', { reasoning: 2, coding: 3, speed: 5, context: 1 }),
        parent: 'api-dev',
      },
      agent('reviewer', 'quality', { reasoning: 4, coding: 4, speed: 3, context: 3 }),
    ],
    tasks: [
      task('design', 'architect', []),
      task('api', 'api-dev', ['design'], 'reviewer'),
      task('tests', 'test-writer', ['design']),
      task('docs', 'architect', ['api', 'tests']),
    ],
    channels: [{ from: 'api-dev', to: 'test-writer', purpose: 'Share the API contract.' }],
    risks: ['Scope creep'],
  };
}

function agent(id: string, layer: string, requirements: Plan['agents'][number]['requirements']) {
  return {
    id,
    name: id,
    role: `${id} role`,
    layer,
    responsibilities: [`${id} work`],
    instructions: '',
    permissions: [
      'read_files',
      'write_files',
      'message_agents',
    ] as Plan['agents'][number]['permissions'],
    requirements,
  };
}

function task(id: string, agentId: string, dependsOn: string[], reviewer?: string) {
  return {
    id,
    title: id,
    description: `Do ${id}`,
    agent: agentId,
    dependsOn,
    deliverables: [`${id} output`],
    acceptanceCriteria: [`${id} is done`],
    ...(reviewer ? { reviewer } : {}),
  };
}
