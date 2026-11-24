import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.ts';
import { SecretBox } from '../src/server/secrets.ts';
import { Store } from '../src/server/store.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup() {
  const store = new Store(':memory:');
  app = await buildApp({ store, secrets: new SecretBox(Buffer.alloc(32, 1)), mockDelayMs: 0 });
  const api = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const response = await app!.inject({
      method,
      url,
      payload: payload as object,
      headers: { host: '127.0.0.1:4317' },
    });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };
  return { store, api };
}

const projectInput = () => ({
  name: 'Brokerage',
  description: 'Real estate brokerage management with Laravel, PostgreSQL and React.',
  stack: ['Laravel', 'React'],
  workspace: mkdtempSync(join(tmpdir(), 'polyphony-api-')),
});

describe('HTTP API', () => {
  it('takes a project from description to a finished run', async () => {
    const { api } = await setup();
    const created = await api('POST', '/api/projects', projectInput());
    expect(created.status).toBe(201);
    const projectId = created.body.id;

    const generated = await api('POST', `/api/projects/${projectId}/plans/generate`, {});
    expect(generated.status).toBe(200);
    const plan = generated.body.plan;
    expect(plan.version).toBe(1);
    expect(plan.origin.model).toBe('mock/mock-model');
    expect(plan.plan.agents.every((a: { model?: unknown }) => a.model)).toBe(true);

    const early = await api('POST', `/api/projects/${projectId}/runs`, { planId: plan.id });
    expect(early.status).toBe(409);

    expect((await api('POST', `/api/plans/${plan.id}/approve`)).status).toBe(200);
    const started = await api('POST', `/api/projects/${projectId}/runs`, {
      planId: plan.id,
      settings: { concurrency: 4, budgetUsd: 1 },
    });
    expect(started.status).toBe(201);

    let run: Record<string, any> = {};
    for (let i = 0; i < 300; i++) {
      run = (await api('GET', `/api/runs/${started.body.id}`)).body;
      if (['completed', 'failed'].includes(run.state.phase)) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(run.state.phase).toBe('completed');
    expect(Object.values(run.state.tasks).every((t: any) => t.status === 'done')).toBe(true);

    const files = await api('GET', `/api/projects/${projectId}/files`);
    expect(files.body.files).toContain('deliverables/architecture.md');
    const file = await api(
      'GET',
      `/api/projects/${projectId}/files?path=deliverables/architecture.md`,
    );
    expect(file.body.content).toContain('# Architecture and module plan');
    const outside = await api('GET', `/api/projects/${projectId}/files?path=../../secret`);
    expect(outside.status).toBe(400);
  });

  it('saves an edited plan as a new version and rejects broken ones', async () => {
    const { api } = await setup();
    const projectId = (await api('POST', '/api/projects', projectInput())).body.id;
    const v1 = (await api('POST', `/api/projects/${projectId}/plans/generate`, {})).body.plan;
    const edited = { ...v1.plan, summary: 'Edited by hand.' };
    const v2 = await api('POST', `/api/projects/${projectId}/plans`, {
      plan: edited,
      basedOn: v1.id,
    });
    expect(v2.body.plan.version).toBe(2);
    expect(v2.body.plan.plan.summary).toBe('Edited by hand.');

    const broken = { ...v1.plan, tasks: [{ ...v1.plan.tasks[0], dependsOn: ['nope'] }] };
    const rejected = await api('POST', `/api/projects/${projectId}/plans`, { plan: broken });
    expect(rejected.status).toBe(422);
    expect(rejected.body.issues[0]).toContain('unknown task "nope"');
  });

  it('stores API keys encrypted and only ever returns them masked', async () => {
    const { api, store } = await setup();
    const saved = await api('PUT', '/api/providers/anthropic', {
      kind: 'anthropic',
      label: 'Anthropic',
      apiKey: 'sk-ant-api03-supersecret',
    });
    expect(saved.status).toBe(200);
    const raw = store.listProviders().find((p) => p.id === 'anthropic')?.secret ?? '';
    expect(raw).not.toContain('supersecret');
    const listed = (await api('GET', '/api/providers')).body as unknown as Record<
      string,
      unknown
    >[];
    expect(JSON.stringify(listed)).not.toContain('supersecret');
    expect(listed.find((p) => p.id === 'anthropic')).toMatchObject({
      hasKey: true,
      maskedKey: 'sk-a…cret',
      usable: true,
    });

    // With a real provider usable, the offline mock leaves the model pool.
    const settings = (await api('GET', '/api/settings')).body;
    expect(settings.demoMode).toBe(false);
    expect(settings.available.every((m: { provider: string }) => m.provider === 'anthropic')).toBe(
      true,
    );
  });

  it('refuses requests that do not come from this machine', async () => {
    await setup();
    const foreignHost = await app!.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example:4317' },
    });
    expect(foreignHost.statusCode).toBe(403);
    const crossSite = await app!.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { host: '127.0.0.1:4317', origin: 'https://evil.example' },
      payload: projectInput(),
    });
    expect(crossSite.statusCode).toBe(403);
    const local = await app!.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:5317', origin: 'http://localhost:5317' },
    });
    expect(local.statusCode).toBe(200);
  });

  it('streams run events to the dashboard', async () => {
    const { api } = await setup();
    const projectId = (await api('POST', '/api/projects', projectInput())).body.id;
    const plan = (await api('POST', `/api/projects/${projectId}/plans/generate`, {})).body.plan;
    await api('POST', `/api/plans/${plan.id}/approve`);
    const runId = (await api('POST', `/api/projects/${projectId}/runs`, { planId: plan.id })).body
      .id;

    await app!.listen({ host: '127.0.0.1', port: 0 });
    const port = (app!.server.address() as { port: number }).port;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events`, {
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('"phase":"completed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    const seqs = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
