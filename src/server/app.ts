import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  guessModelInfo,
  type ModelInfo,
  ModelInfoSchema,
  STRATEGY_PRESETS,
  StrategySchema,
  selectModel,
} from '../core/models.ts';
import { ModelRefSchema, PlanSchema, validatePlan } from '../core/plan.ts';
import { emptyRunState, type RunEvent } from '../core/run-state.ts';
import { createProvider, PROVIDER_KINDS, type ProviderConfig } from '../providers/registry.ts';
import { type ChatProvider, ProviderError } from '../providers/types.ts';
import { analyzeRepository } from './analyzer.ts';
import { assignModels, generatePlan, PLANNER_REQUIREMENTS, PlannerError } from './planner.ts';
import { RunManager } from './runs.ts';
import { Workspace, WorkspaceError } from './runtime/workspace.ts';
import { maskSecret, type SecretBox } from './secrets.ts';
import type { Store } from './store.ts';

const ProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(20_000),
  stack: z.array(z.string().trim().min(1)).max(40).default([]),
  instructions: z.string().max(20_000).default(''),
  deliverables: z.array(z.string().trim().min(1)).max(100).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1)).max(100).default([]),
  workspace: z.string().trim().min(1),
  repository: z
    .string()
    .trim()
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

const RunSettingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16).default(3),
  budgetUsd: z.number().min(0).max(10_000).default(5),
  allowCommands: z.boolean().default(false),
  maxTurns: z.number().int().min(2).max(200).default(30),
});

const ProviderInputSchema = z.object({
  kind: z.enum(PROVIDER_KINDS),
  label: z.string().trim().min(1).max(60),
  baseURL: z
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  enabled: z.boolean().default(true),
  /** Omit to keep the stored key, send null to remove it. */
  apiKey: z.string().trim().min(1).max(500).nullable().optional(),
});

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface AppOptions {
  store: Store;
  secrets: SecretBox;
  /** Built web app to serve, if present. */
  webDir?: string;
  logger?: boolean;
  mockDelayMs?: number;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { store, secrets } = options;
  const runs = new RunManager(store);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  // The server holds API keys and can run approved commands, so it only talks to this machine:
  // other Hosts (DNS rebinding) and cross-site Origins are refused.
  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTS.has(host))
      return reply.code(403).send({ error: 'Polyphony only accepts local requests.' });
    const origin = request.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).hostname;
      } catch {
        // invalid origin: refused below
      }
      if (!LOCAL_HOSTS.has(originHost) && !LOCAL_HOSTS.has(`[${originHost}]`)) {
        return reply.code(403).send({ error: 'Cross-site requests are not allowed.' });
      }
    }
  });

  app.addHook('onClose', async () => runs.cancelAll());

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        issues: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    if (error instanceof WorkspaceError) return reply.code(400).send({ error: error.message });
    if (error instanceof PlannerError)
      return reply.code(422).send({ error: error.message, issues: error.issues });
    if (error instanceof ProviderError) {
      return reply
        .code(error.kind === 'auth' ? 401 : 502)
        .send({ error: error.message, provider: error.provider });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    app.log.error(error);
    return reply.code(500).send({ error: 'Internal error' });
  });

  // helpers

  const providerConfigs = () => store.listProviders();
  const providerFor = (id: string): ChatProvider | undefined => {
    const config = providerConfigs().find((p) => p.id === id && p.enabled);
    if (!config) return undefined;
    const needsKey = config.kind !== 'mock' && config.kind !== 'openai-compatible';
    if (needsKey && !config.secret) return undefined;
    return createProvider(
      config,
      config.secret ? secrets.open(config.secret) : '',
      options.mockDelayMs,
    );
  };
  /** Models the team can actually use. The offline mock only counts when no real provider is usable. */
  const availableCatalog = (): ModelInfo[] => {
    const usable = new Set(
      providerConfigs()
        .filter((p) => providerFor(p.id))
        .map((p) => p.id),
    );
    const models = store.listModels().filter((m) => m.enabled && usable.has(m.provider));
    const real = models.filter((m) => m.provider !== 'mock');
    return real.length > 0 ? real : models;
  };
  const providerMap = () => {
    const map = new Map<string, ChatProvider>();
    for (const config of providerConfigs()) {
      const provider = providerFor(config.id);
      if (provider) map.set(config.id, provider);
    }
    return map;
  };
  const notFound = (reply: FastifyReply, what: string) =>
    reply.code(404).send({ error: `${what} not found` });

  // health and settings

  app.get('/api/health', async () => ({ ok: true, version: '0.1.0' }));

  app.get('/api/settings', async () => ({
    strategy: store.strategy(),
    presets: STRATEGY_PRESETS,
    available: availableCatalog().map((m) => ({ provider: m.provider, id: m.id })),
    demoMode: availableCatalog().every((m) => m.provider === 'mock'),
  }));

  app.put('/api/settings/strategy', async (request) => {
    const strategy = StrategySchema.parse(request.body);
    store.setSetting('strategy', strategy);
    return { strategy };
  });

  // providers

  app.get('/api/providers', async () =>
    providerConfigs().map(({ secret, ...config }) => ({
      ...config,
      hasKey: secret !== null,
      maskedKey: secret ? maskSecret(secrets.open(secret)) : null,
      usable: providerFor(config.id) !== undefined,
    })),
  );

  app.put<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    const input = ProviderInputSchema.parse(request.body);
    const config: ProviderConfig = {
      id: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,31}$/)
        .parse(request.params.id),
      kind: input.kind,
      label: input.label,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      enabled: input.enabled,
    };
    const sealed =
      input.apiKey === undefined
        ? undefined
        : input.apiKey === null
          ? null
          : secrets.seal(input.apiKey);
    store.saveProvider(config, sealed);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/providers/:id', async (request) => {
    store.deleteProvider(request.params.id);
    return { ok: true };
  });

  /** Checks the key by listing models, and adds models the catalog does not know yet. */
  app.post<{ Params: { id: string } }>('/api/providers/:id/sync', async (request, reply) => {
    const provider = providerFor(request.params.id);
    if (!provider)
      return reply.code(400).send({ error: 'The provider is disabled or has no API key.' });
    const found = await provider.listModels();
    const added = store.addModelsIfMissing(
      found.map((m) => guessModelInfo(provider.id, m.id, m.label)),
    );
    return { ok: true, models: found.length, added };
  });

  // models

  app.get('/api/models', async () => store.listModels());

  app.put('/api/models', async (request) => {
    const model = ModelInfoSchema.parse({ ...(request.body as object), source: 'user' });
    store.saveModel(model);
    return model;
  });

  // projects

  app.get('/api/projects', async () => store.listProjects());

  app.post('/api/projects', async (request, reply) => {
    const project = store.createProject(ProjectInputSchema.parse(request.body));
    return reply.code(201).send(project);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'Project');
    return {
      project,
      plans: store.listPlans(project.id),
      runs: store.listRuns(project.id).map(({ state: _s, ...run }) => run),
    };
  });

  app.put<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const project = store.updateProject(request.params.id, ProjectInputSchema.parse(request.body));
    return project ?? notFound(reply, 'Project');
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request) => {
    store.deleteProject(request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/analyze', async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'Project');
    return analyzeRepository(project.workspace);
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/files',
    async (request, reply) => {
      const project = store.getProject(request.params.id);
      if (!project) return notFound(reply, 'Project');
      if (!existsSync(project.workspace)) return { files: [], content: null };
      const workspace = new Workspace(project.workspace);
      const path = request.query.path;
      if (!path) return { files: workspace.list('.', 6), content: null };
      return { files: null, content: workspace.read(path) };
    },
  );

  // plans

  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/plans/generate',
    async (request, reply) => {
      const project = store.getProject(request.params.id);
      if (!project) return notFound(reply, 'Project');
      const body = z.object({ planner: ModelRefSchema.optional() }).parse(request.body ?? {});
      const catalog = availableCatalog();
      const strategy = store.strategy();
      const plannerRef =
        body.planner ??
        selectModel(PLANNER_REQUIREMENTS, catalog, { ...strategy, avoidOverkill: false })?.model;
      const plannerModel =
        plannerRef &&
        catalog.find((m) => m.provider === plannerRef.provider && m.id === plannerRef.id);
      const provider = plannerModel && providerFor(plannerModel.provider);
      if (!plannerModel || !provider)
        return reply
          .code(400)
          .send({ error: 'No usable model for planning. Add an API key in Settings.' });

      const analysis = analyzeRepository(project.workspace);
      const result = await generatePlan({
        provider,
        model: plannerModel,
        project,
        analysis,
        catalog,
      });
      const { plan, unassigned } = assignModels(result.plan, catalog, strategy);
      const record = store.createPlan(project.id, plan, {
        model: `${plannerModel.provider}/${plannerModel.id}`,
        usage: result.usage,
        cost: result.cost,
        analysis,
      });
      return { plan: record, unassigned, attempts: result.attempts };
    },
  );

  /** Saves an edited plan as a new version. */
  app.post<{ Params: { id: string } }>('/api/projects/:id/plans', async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'Project');
    const body = z
      .object({ plan: z.unknown(), basedOn: z.string().optional() })
      .parse(request.body);
    const { plan, issues } = validatePlan(body.plan);
    if (!plan)
      return reply.code(422).send({
        error: 'The plan is invalid',
        issues: issues.map((i) => `${i.path}: ${i.message}`),
      });
    const assigned = assignModels(plan, availableCatalog(), store.strategy(), true);
    const previous = body.basedOn ? store.getPlan(body.basedOn) : undefined;
    const record = store.createPlan(project.id, assigned.plan, {
      model: 'edited',
      usage: { inputTokens: 0, outputTokens: 0 },
      cost: 0,
      analysis: previous?.origin.analysis ?? null,
    });
    return { plan: record, unassigned: assigned.unassigned };
  });

  /** Re-runs model selection on a plan without saving it, e.g. after changing the strategy. */
  app.post('/api/plans/assign-models', async (request) => {
    const body = z
      .object({ plan: PlanSchema, keepExisting: z.boolean().default(false) })
      .parse(request.body);
    return assignModels(body.plan, availableCatalog(), store.strategy(), body.keepExisting);
  });

  app.post<{ Params: { id: string } }>('/api/plans/:id/approve', async (request, reply) => {
    const plan = store.getPlan(request.params.id);
    if (!plan) return notFound(reply, 'Plan');
    store.approvePlan(plan.id);
    return { ok: true };
  });

  // runs

  app.post<{ Params: { id: string } }>('/api/projects/:id/runs', async (request, reply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'Project');
    const body = z
      .object({
        planId: z.string(),
        settings: RunSettingsSchema.default(RunSettingsSchema.parse({})),
      })
      .parse(request.body);
    const plan = store.getPlan(body.planId);
    if (!plan || plan.projectId !== project.id) return notFound(reply, 'Plan');
    if (plan.status !== 'approved')
      return reply.code(409).send({ error: 'Approve the plan before launching it.' });
    const run = runs.start({
      project,
      planId: plan.id,
      plan: plan.plan,
      settings: body.settings,
      catalog: availableCatalog(),
      strategy: store.strategy(),
      providers: providerMap(),
    });
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) return notFound(reply, 'Run');
    const live = runs.state(run.id);
    return { ...run, state: live ?? run.state ?? emptyRunState(run.id), live: live !== undefined };
  });

  /** Server-sent events: stored events after `after`, then live ones. */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      const run = store.getRun(request.params.id);
      if (!run) return notFound(reply, 'Run');
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let last = Number(request.query.after ?? 0) || 0;
      const send = (event: RunEvent | { seq: number; type: string }) => {
        if (event.seq <= last) return;
        last = event.seq;
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const backlog: RunEvent[] = [];
      const unsubscribe = runs.subscribe(run.id, (event) => backlog.push(event));
      for (const event of store.listEvents(run.id, last, 100_000))
        send(event as unknown as RunEvent);
      for (const event of backlog.splice(0)) send(event);
      const stop = runs.subscribe(run.id, send);
      unsubscribe();
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      request.raw.on('close', () => {
        clearInterval(ping);
        stop();
      });
    },
  );

  const control =
    (action: (o: NonNullable<ReturnType<RunManager['orchestrator']>>, body: unknown) => unknown) =>
    async (request: { params: { id: string }; body: unknown }, reply: FastifyReply) => {
      const orchestrator = runs.orchestrator(request.params.id);
      if (!orchestrator) return reply.code(409).send({ error: 'The run is not active.' });
      return { ok: action(orchestrator, request.body) ?? true };
    };

  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/pause',
    control((o) => o.pause()),
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/resume',
    control((o) => o.resume()),
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/cancel',
    control((o) => o.cancel()),
  );
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/budget',
    control((o, body) =>
      o.setBudget(z.object({ budgetUsd: z.number().min(0).max(10_000) }).parse(body).budgetUsd),
    ),
  );
  app.post<{ Params: { id: string; eid: string } }>(
    '/api/runs/:id/escalations/:eid',
    async (request, reply) => {
      const { answer } = z
        .object({ answer: z.string().trim().min(1).max(4000) })
        .parse(request.body);
      const ok = runs.orchestrator(request.params.id)?.answerEscalation(request.params.eid, answer);
      return ok ? { ok } : reply.code(409).send({ error: 'No open escalation with this id.' });
    },
  );
  app.post<{ Params: { id: string; aid: string } }>(
    '/api/runs/:id/approvals/:aid',
    async (request, reply) => {
      const { approve } = z.object({ approve: z.boolean() }).parse(request.body);
      const ok = runs.orchestrator(request.params.id)?.resolveApproval(request.params.aid, approve);
      return ok ? { ok } : reply.code(409).send({ error: 'No pending approval with this id.' });
    },
  );

  // web app

  if (options.webDir && existsSync(options.webDir)) {
    await app.register(fastifyStatic, { root: options.webDir, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
