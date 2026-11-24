import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Layers,
  Play,
  Rocket,
  Save,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { criticalPath, executionWaves, validatePlan } from '../../../src/core/plan.ts';
import {
  ago,
  api,
  type ModelInfo,
  money,
  type Plan,
  type PlanRecord,
  type Project,
  type RunRecord,
  type RunSettings,
  tokens,
} from '../api.ts';
import { PlanGraph } from '../PlanGraph.tsx';
import { href, navigate } from '../router.ts';
import { RUN_PHASE } from '../status.ts';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Spinner, Tabs } from '../ui.tsx';
import { PlanEditor } from './PlanEditor.tsx';
import { ProjectForm } from './ProjectForm.tsx';

type Tab = 'plan' | 'runs' | 'files' | 'brief';

export function ProjectPage({ id, tab }: { id: string; tab: Tab }) {
  const [data, setData] = useState<{
    project: Project;
    plans: PlanRecord[];
    runs: Omit<RunRecord, 'state'>[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.project(id).then(setData, setError), [id]);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner label="Loading project" />;
  const { project, plans, runs } = data;
  const setTab = (t: Tab) => navigate({ page: 'project', id, tab: t });

  return (
    <div className="space-y-6">
      <a
        href={href({ page: 'projects' })}
        className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-ink"
      >
        <ArrowLeft className="size-4" /> Projects
      </a>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
          <p className="mt-1 max-w-3xl text-sm text-dim">{project.description}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {project.stack.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
            <code className="ml-1 truncate rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-faint">
              {project.workspace}
            </code>
          </div>
        </div>
      </div>
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'plan', label: 'Orchestration plan', count: plans.length },
          { value: 'runs', label: 'Runs', count: runs.length },
          { value: 'files', label: 'Workspace' },
          { value: 'brief', label: 'Brief' },
        ]}
      />
      {tab === 'plan' && <PlanTab project={project} plans={plans} reload={load} />}
      {tab === 'runs' && <RunsTab runs={runs} />}
      {tab === 'files' && <FilesTab projectId={project.id} />}
      {tab === 'brief' && (
        <Card className="p-6">
          <ProjectForm
            initial={project}
            submitLabel="Save brief"
            onSubmit={async (input) => {
              await api.updateProject(project.id, input);
              await load();
            }}
          />
        </Card>
      )}
    </div>
  );
}

function PlanTab({
  project,
  plans,
  reload,
}: {
  project: Project;
  plans: PlanRecord[];
  reload: () => Promise<unknown>;
}) {
  const [selectedId, setSelectedId] = useState(plans[0]?.id ?? null);
  const record = plans.find((p) => p.id === selectedId) ?? plans[0] ?? null;
  const [draft, setDraft] = useState<Plan | null>(record?.plan ?? null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    setDraft(record?.plan ?? null);
  }, [record]);
  useEffect(() => {
    Promise.all([api.models(), api.settings()]).then(([all, settings]) => {
      const available = new Set(settings.available.map((m) => `${m.provider}/${m.id}`));
      setModels(all.filter((m) => available.has(`${m.provider}/${m.id}`)));
    }, setError);
  }, []);

  const dirty =
    record !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(record.plan);
  const issues = useMemo(() => (draft ? validatePlan(draft).issues : []), [draft]);

  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const generate = () =>
    act('generate', async () => {
      const result = await api.generatePlan(project.id);
      await reload();
      setSelectedId(result.plan.id);
    });
  const save = () =>
    act('save', async () => {
      if (!draft || !record) return;
      const result = await api.savePlan(project.id, draft, record.id);
      await reload();
      setSelectedId(result.plan.id);
    });
  const reassign = () =>
    act('reassign', async () => {
      if (!draft) return;
      setDraft((await api.assignModels(draft, false)).plan);
    });
  const approve = () =>
    act('approve', async () => {
      if (!record) return;
      await api.approvePlan(record.id);
      await reload();
    });

  if (busy === 'generate') {
    return (
      <Card className="overflow-hidden">
        <div className="shimmer h-1" />
        <Empty
          icon={<Wand2 className="size-6 animate-pulse" />}
          title="The orchestration architect is designing your team"
        >
          Analysing the workspace, choosing layers and roles, rating what each role needs, splitting
          the work into parallel tasks and matching every agent to a model. This takes a moment with
          a real model.
        </Empty>
      </Card>
    );
  }

  if (!record || !draft) {
    return (
      <Card>
        <Empty icon={<Sparkles className="size-6" />} title="No plan yet">
          Polyphony analyses the project and proposes the layers, agents, subagents, models, tasks
          and dependencies. You can change everything before you approve it.
          <div className="mt-4 flex justify-center">
            <Button variant="primary" icon={<Wand2 className="size-4" />} onClick={generate}>
              Design the orchestration plan
            </Button>
          </div>
          <div className="mt-3">
            <ErrorNote error={error} />
          </div>
        </Empty>
      </Card>
    );
  }

  const waves = (() => {
    try {
      return executionWaves(draft.tasks);
    } catch {
      return [];
    }
  })();
  const path = issues.length ? [] : criticalPath(draft.tasks);
  const approved = record.status === 'approved' && !dirty;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={record.id}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5 text-sm"
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                Version {p.version} · {p.status} · {ago(p.createdAt)}
              </option>
            ))}
          </select>
          <Badge tone={approved ? 'ok' : dirty ? 'warn' : 'neutral'}>
            {approved ? 'Approved' : dirty ? 'Unsaved changes' : 'Draft'}
          </Badge>
          <span className="text-xs text-faint">
            by {record.origin.model} ·{' '}
            {tokens(record.origin.usage.inputTokens + record.origin.usage.outputTokens)} tokens ·{' '}
            {money(record.origin.cost)}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            icon={<Wand2 className="size-4" />}
            onClick={generate}
            busy={busy === 'generate'}
          >
            New plan
          </Button>
          <Button
            icon={<Layers className="size-4" />}
            onClick={reassign}
            busy={busy === 'reassign'}
          >
            Re-match models
          </Button>
          <Button
            icon={<Save className="size-4" />}
            onClick={save}
            busy={busy === 'save'}
            disabled={!dirty || issues.length > 0}
          >
            Save as new version
          </Button>
          {approved ? (
            <Button
              variant="primary"
              icon={<Rocket className="size-4" />}
              onClick={() => setLaunching(true)}
            >
              Launch
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<CheckCircle2 className="size-4" />}
              onClick={approve}
              busy={busy === 'approve'}
              disabled={dirty || issues.length > 0}
            >
              Approve plan
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={error} />
      {issues.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" /> Fix these before saving:
          </div>
          <ul className="mt-1 list-disc pl-6 text-xs">
            {issues.slice(0, 8).map((i) => (
              <li key={`${i.path}${i.message}`}>
                {i.path}: {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card
          title="Task graph"
          action={
            <span className="text-xs text-faint">
              {waves.length} parallel waves · critical path {path.length} tasks
            </span>
          }
        >
          <div className="p-3">
            <PlanGraph plan={draft} />
          </div>
        </Card>
        <Card title="Summary">
          <div className="space-y-4 p-5 text-sm">
            <p className="text-dim">{draft.summary}</p>
            <div>
              <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
                Architecture
              </div>
              <div className="flex flex-wrap gap-1.5">
                {draft.architecture.stack.map((s) => (
                  <Badge key={s} tone="accent">
                    {s}
                  </Badge>
                ))}
              </div>
              {draft.architecture.notes && (
                <p className="mt-2 text-xs text-dim">{draft.architecture.notes}</p>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-xl border border-line bg-bg/40 p-3 text-center">
              <div>
                <div className="font-mono text-lg font-semibold">{draft.layers.length}</div>
                <div className="text-[10px] text-faint">layers</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold">{draft.agents.length}</div>
                <div className="text-[10px] text-faint">agents</div>
              </div>
              <div>
                <div className="font-mono text-lg font-semibold">{draft.tasks.length}</div>
                <div className="text-[10px] text-faint">tasks</div>
              </div>
            </div>
            {draft.channels.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Direct channels
                </div>
                <ul className="space-y-1 text-xs text-dim">
                  {draft.channels.map((c) => (
                    <li key={`${c.from}-${c.to}`}>
                      <span className="text-ink">{c.from}</span> ↔{' '}
                      <span className="text-ink">{c.to}</span>: {c.purpose}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {draft.risks.length > 0 && (
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">
                  Risks
                </div>
                <ul className="list-disc space-y-1 pl-4 text-xs text-dim">
                  {draft.risks.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      </div>

      <PlanEditor plan={draft} models={models} onChange={setDraft} readOnly={approved} />

      {launching && (
        <LaunchDialog
          onClose={() => setLaunching(false)}
          onLaunch={async (settings) => {
            const run = await api.startRun(project.id, record.id, settings);
            navigate({ page: 'run', id: run.id });
          }}
          canRunCommands={draft.agents.some((a) => a.permissions.includes('run_commands'))}
        />
      )}
    </div>
  );
}

function LaunchDialog({
  onClose,
  onLaunch,
  canRunCommands,
}: {
  onClose: () => void;
  onLaunch: (settings: RunSettings) => Promise<void>;
  canRunCommands: boolean;
}) {
  const [settings, setSettings] = useState<RunSettings>({
    concurrency: 3,
    budgetUsd: 5,
    allowCommands: false,
    maxTurns: 30,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-line bg-panel p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Launch the run"
      >
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Rocket className="size-5 text-accent" /> Launch the run
        </h2>
        <p className="mt-1 text-sm text-dim">
          Agents start on every task whose dependencies are met. You can pause or cancel at any
          time.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-4">
          <Field label="Agents in parallel">
            <Input
              type="number"
              min={1}
              max={16}
              value={settings.concurrency}
              onChange={(e) => setSettings({ ...settings, concurrency: Number(e.target.value) })}
            />
          </Field>
          <Field label="Budget (USD)" hint="Pauses when reached.">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={settings.budgetUsd}
              onChange={(e) => setSettings({ ...settings, budgetUsd: Number(e.target.value) })}
            />
          </Field>
          <Field label="Max turns per task">
            <Input
              type="number"
              min={2}
              max={200}
              value={settings.maxTurns}
              onChange={(e) => setSettings({ ...settings, maxTurns: Number(e.target.value) })}
            />
          </Field>
        </div>
        <label className="mt-4 flex items-start gap-2.5 rounded-lg border border-line bg-bg/40 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 accent-[#7c9cff]"
            checked={settings.allowCommands}
            onChange={(e) => setSettings({ ...settings, allowCommands: e.target.checked })}
          />
          <span>
            Allow shell commands
            <span className="block text-xs text-dim">
              {canRunCommands
                ? 'Agents with the “Run commands” permission can ask to run builds and tests. You approve each command.'
                : 'No agent in this plan has the “Run commands” permission.'}
            </span>
          </span>
        </label>
        <ErrorNote error={error} />
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            icon={<Play className="size-4" />}
            onClick={async () => {
              setBusy(true);
              try {
                await onLaunch(settings);
              } catch (e) {
                setError(e);
                setBusy(false);
              }
            }}
          >
            Launch
          </Button>
        </div>
      </div>
    </div>
  );
}

function RunsTab({ runs }: { runs: Omit<RunRecord, 'state'>[] }) {
  if (runs.length === 0) {
    return (
      <Card>
        <Empty icon={<Play className="size-6" />} title="No runs yet">
          Approve a plan and launch it to watch the agents work.
        </Empty>
      </Card>
    );
  }
  return (
    <Card>
      <div className="divide-y divide-line">
        {runs.map((run) => (
          <a
            key={run.id}
            href={href({ page: 'run', id: run.id })}
            className="flex items-center justify-between gap-4 px-5 py-3.5 transition hover:bg-panel-2"
          >
            <div className="flex items-center gap-3">
              <Badge tone={RUN_PHASE[run.status].tone}>{RUN_PHASE[run.status].label}</Badge>
              <code className="text-xs text-dim">{run.id}</code>
            </div>
            <div className="text-xs text-faint">
              started {ago(run.startedAt)} · budget {money(run.settings.budgetUsd)}
            </div>
          </a>
        ))}
      </div>
    </Card>
  );
}

function FilesTab({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.files(projectId).then((r) => setFiles(r.files), setError);
  }, [projectId]);

  return (
    <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
      <Card title="Files">
        <div className="max-h-[70vh] overflow-auto p-2">
          <ErrorNote error={error} />
          {!files && !error && <Spinner />}
          {files?.length === 0 && (
            <div className="p-3 text-sm text-faint">The workspace is empty.</div>
          )}
          {files?.map((f) =>
            f.endsWith('/') ? (
              <div key={f} className="px-2 py-1 font-mono text-[11px] text-faint">
                {f}
              </div>
            ) : (
              <button
                key={f}
                type="button"
                onClick={() =>
                  api
                    .file(projectId, f)
                    .then((r) => setOpen({ path: f, content: r.content }), setError)
                }
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-xs text-dim hover:bg-panel-2 hover:text-ink"
              >
                <FileText className="size-3.5 shrink-0" />
                <span className="truncate">{f}</span>
              </button>
            ),
          )}
        </div>
      </Card>
      <Card title={open?.path ?? 'Preview'}>
        <pre className="max-h-[70vh] overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-dim">
          {open?.content ?? 'Select a file.'}
        </pre>
      </Card>
    </div>
  );
}
