import { Bot, GitBranch, Plus, Trash2, Users } from 'lucide-react';
import { PERMISSIONS, type Permission, type Requirements } from '../../../src/core/plan.ts';
import type { ModelInfo, ModelRef, Plan } from '../api.ts';
import { layerColor } from '../status.ts';
import { Badge, Button, Card, cx, Input, Select, Textarea } from '../ui.tsx';

type Agent = Plan['agents'][number];
type Task = Plan['tasks'][number];

const REQUIREMENTS: { key: keyof Requirements; label: string }[] = [
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'coding', label: 'Coding' },
  { key: 'speed', label: 'Speed' },
  { key: 'context', label: 'Context' },
];

const PERMISSION_LABELS: Record<Permission, string> = {
  read_files: 'Read files',
  write_files: 'Write files',
  run_commands: 'Run commands',
  message_agents: 'Message agents',
};

function slug(text: string, taken: Set<string>): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'item';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** Edits a plan in place: agents grouped by layer, then tasks with their dependencies. */
export function PlanEditor({
  plan,
  models,
  onChange,
  readOnly,
}: {
  plan: Plan;
  models: ModelInfo[];
  onChange: (plan: Plan) => void;
  readOnly: boolean;
}) {
  const layers = plan.layers.map((l) => l.id);
  const updateAgent = (id: string, patch: Partial<Agent>) =>
    onChange({ ...plan, agents: plan.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const updateTask = (id: string, patch: Partial<Task>) =>
    onChange({ ...plan, tasks: plan.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  const removeAgent = (id: string) =>
    onChange({
      ...plan,
      agents: plan.agents
        .filter((a) => a.id !== id)
        .map((a) => (a.parent === id ? { ...a, parent: undefined } : a)),
      tasks: plan.tasks
        .filter((t) => t.agent !== id)
        .map((t) => (t.reviewer === id ? { ...t, reviewer: undefined } : t)),
      channels: plan.channels.filter((c) => c.from !== id && c.to !== id),
    });
  const removeTask = (id: string) =>
    onChange({
      ...plan,
      tasks: plan.tasks
        .filter((t) => t.id !== id)
        .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })),
    });

  const addAgent = (layer: string) => {
    const id = slug('new-agent', new Set(plan.agents.map((a) => a.id)));
    onChange({
      ...plan,
      agents: [
        ...plan.agents,
        {
          id,
          name: 'New agent',
          role: 'Describe the role',
          layer,
          responsibilities: ['Describe what this agent owns'],
          instructions: '',
          permissions: ['read_files', 'write_files'],
          requirements: { reasoning: 3, coding: 3, speed: 3, context: 2 },
        },
      ],
    });
  };
  const addTask = () => {
    const id = slug('new-task', new Set(plan.tasks.map((t) => t.id)));
    const agent = plan.agents[0]?.id ?? '';
    onChange({
      ...plan,
      tasks: [
        ...plan.tasks,
        {
          id,
          title: 'New task',
          description: 'Describe the task.',
          agent,
          dependsOn: [],
          deliverables: [],
          acceptanceCriteria: ['Describe how to check it'],
        },
      ],
    });
  };

  const modelOptions = [
    { value: '', label: 'Auto (by strategy)' },
    ...models.map((m) => ({ value: `${m.provider}/${m.id}`, label: `${m.label} · ${m.provider}` })),
  ];
  const agentOptions = plan.agents.map((a) => ({ value: a.id, label: a.name }));

  return (
    <div className="space-y-6">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Users className="size-4 text-accent" /> Agents
            <Badge>{plan.agents.length}</Badge>
          </span>
        }
      >
        <div className="divide-y divide-line">
          {plan.layers.map((layer) => {
            const agents = plan.agents.filter((a) => a.layer === layer.id);
            return (
              <div key={layer.id} className="px-5 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="size-2.5 rounded-full"
                      style={{ background: layerColor(layers, layer.id) }}
                    />
                    <h3 className="text-sm font-semibold">{layer.name}</h3>
                    <span className="text-xs text-faint">{layer.purpose}</span>
                  </div>
                  {!readOnly && (
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      icon={<Plus className="size-3.5" />}
                      onClick={() => addAgent(layer.id)}
                    >
                      Agent
                    </Button>
                  )}
                </div>
                <div className="grid gap-3 lg:grid-cols-2">
                  {agents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      plan={plan}
                      models={models}
                      modelOptions={modelOptions}
                      readOnly={readOnly}
                      onChange={(patch) => updateAgent(agent.id, patch)}
                      onRemove={() => removeAgent(agent.id)}
                    />
                  ))}
                  {agents.length === 0 && (
                    <div className="text-xs text-faint">No agents in this layer.</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card
        title={
          <span className="flex items-center gap-2">
            <GitBranch className="size-4 text-accent" /> Tasks
            <Badge>{plan.tasks.length}</Badge>
          </span>
        }
        action={
          !readOnly && (
            <Button
              variant="ghost"
              className="px-2 py-1 text-xs"
              icon={<Plus className="size-3.5" />}
              onClick={addTask}
            >
              Task
            </Button>
          )
        }
      >
        <div className="divide-y divide-line">
          {plan.tasks.map((task) => (
            <div key={task.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[1.4fr_1fr]">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <code className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-faint">
                    {task.id}
                  </code>
                  {readOnly ? (
                    <span className="text-sm font-semibold">{task.title}</span>
                  ) : (
                    <Input
                      value={task.title}
                      onChange={(e) => updateTask(task.id, { title: e.target.value })}
                      className="py-1 font-semibold"
                    />
                  )}
                </div>
                {readOnly ? (
                  <p className="text-sm text-dim">{task.description}</p>
                ) : (
                  <Textarea
                    value={task.description}
                    onChange={(e) => updateTask(task.id, { description: e.target.value })}
                    rows={2}
                    className="min-h-0 text-xs"
                  />
                )}
                {task.acceptanceCriteria.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-faint">
                    {task.acceptanceCriteria.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="space-y-2 text-xs">
                <div className="grid grid-cols-[70px_1fr] items-center gap-2">
                  <span className="text-faint">Agent</span>
                  {readOnly ? (
                    <span>{plan.agents.find((a) => a.id === task.agent)?.name ?? task.agent}</span>
                  ) : (
                    <Select
                      value={task.agent}
                      options={agentOptions}
                      onChange={(v) => updateTask(task.id, { agent: v })}
                      className="py-1 text-xs"
                    />
                  )}
                  <span className="text-faint">Reviewer</span>
                  {readOnly ? (
                    <span>
                      {task.reviewer
                        ? (plan.agents.find((a) => a.id === task.reviewer)?.name ?? task.reviewer)
                        : '—'}
                    </span>
                  ) : (
                    <Select
                      value={task.reviewer ?? ''}
                      options={[
                        { value: '', label: 'None (or the parent agent)' },
                        ...agentOptions.filter((a) => a.value !== task.agent),
                      ]}
                      onChange={(v) => updateTask(task.id, { reviewer: v || undefined })}
                      className="py-1 text-xs"
                    />
                  )}
                </div>
                <div>
                  <div className="mb-1 text-faint">Depends on</div>
                  <div className="flex flex-wrap gap-1.5">
                    {plan.tasks
                      .filter((t) => t.id !== task.id)
                      .map((other) => {
                        const on = task.dependsOn.includes(other.id);
                        if (readOnly && !on) return null;
                        return (
                          <button
                            key={other.id}
                            type="button"
                            disabled={readOnly}
                            onClick={() =>
                              updateTask(task.id, {
                                dependsOn: on
                                  ? task.dependsOn.filter((d) => d !== other.id)
                                  : [...task.dependsOn, other.id],
                              })
                            }
                            className={cx(
                              'rounded-md border px-1.5 py-0.5 text-[11px] transition',
                              on
                                ? 'border-accent/40 bg-accent/10 text-accent'
                                : 'border-line text-faint hover:text-dim',
                            )}
                          >
                            {other.title}
                          </button>
                        );
                      })}
                    {task.dependsOn.length === 0 && readOnly && (
                      <span className="text-faint">Nothing: starts immediately</span>
                    )}
                  </div>
                </div>
                {!readOnly && (
                  <div className="flex justify-end">
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs text-bad"
                      icon={<Trash2 className="size-3.5" />}
                      onClick={() => removeTask(task.id)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AgentCard({
  agent,
  plan,
  models,
  modelOptions,
  readOnly,
  onChange,
  onRemove,
}: {
  agent: Agent;
  plan: Plan;
  models: ModelInfo[];
  modelOptions: { value: string; label: string }[];
  readOnly: boolean;
  onChange: (patch: Partial<Agent>) => void;
  onRemove: () => void;
}) {
  const modelKey = agent.model ? `${agent.model.provider}/${agent.model.id}` : '';
  const model = models.find((m) => `${m.provider}/${m.id}` === modelKey);
  const parent = agent.parent ? plan.agents.find((a) => a.id === agent.parent) : undefined;
  const tasks = plan.tasks.filter((t) => t.agent === agent.id).length;

  return (
    <div
      className={cx(
        'rounded-xl border border-line bg-bg/40 p-4',
        parent && 'border-l-2 border-l-accent-2/60',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Bot className="size-4 shrink-0 text-accent" />
            {readOnly ? (
              <span className="truncate text-sm font-semibold">{agent.name}</span>
            ) : (
              <Input
                value={agent.name}
                onChange={(e) => onChange({ name: e.target.value })}
                className="py-1 text-sm font-semibold"
              />
            )}
          </div>
          {readOnly ? (
            <div className="text-xs text-dim">{agent.role}</div>
          ) : (
            <Input
              value={agent.role}
              onChange={(e) => onChange({ role: e.target.value })}
              className="py-1 text-xs"
            />
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {parent && <Badge tone="violet">subagent of {parent.name}</Badge>}
            <Badge>
              {tasks} task{tasks === 1 ? '' : 's'}
            </Badge>
          </div>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-1 text-faint hover:bg-bad/10 hover:text-bad"
            aria-label={`Remove ${agent.name}`}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>

      <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-dim">
        {agent.responsibilities.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <div className="mt-3 space-y-1.5">
        <div className="text-[11px] font-medium text-faint">Model</div>
        {readOnly ? (
          <div className="text-sm">{model?.label ?? (modelKey || 'Not assigned')}</div>
        ) : (
          <Select
            value={modelKey}
            options={modelOptions}
            onChange={(v) => {
              if (!v) {
                const { model: _m, modelRationale: _r, ...rest } = agent;
                onChange({ ...rest, model: undefined, modelRationale: undefined });
                return;
              }
              const [provider, ...id] = v.split('/');
              const ref: ModelRef = { provider: provider ?? '', id: id.join('/') };
              onChange({ model: ref, modelRationale: 'Chosen manually.' });
            }}
            className="py-1 text-xs"
          />
        )}
        {agent.modelRationale && (
          <div className="text-[11px] leading-snug text-faint">{agent.modelRationale}</div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {REQUIREMENTS.map(({ key, label }) => (
          <div key={key}>
            <div className="text-[10px] text-faint">{label}</div>
            <div className="mt-1 flex gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={readOnly}
                  onClick={() => onChange({ requirements: { ...agent.requirements, [key]: n } })}
                  className={cx(
                    'h-1.5 flex-1 rounded-full transition',
                    n <= agent.requirements[key] ? 'bg-accent' : 'bg-line',
                    !readOnly && 'hover:bg-accent/60',
                  )}
                  aria-label={`${label} ${n}`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {PERMISSIONS.map((p) => {
          const on = agent.permissions.includes(p);
          if (readOnly && !on) return null;
          return (
            <button
              key={p}
              type="button"
              disabled={readOnly}
              onClick={() =>
                onChange({
                  permissions: on
                    ? agent.permissions.filter((x) => x !== p)
                    : [...agent.permissions, p],
                })
              }
              className={cx(
                'rounded-md border px-1.5 py-0.5 text-[10.5px] transition',
                on
                  ? p === 'run_commands'
                    ? 'border-warn/40 bg-warn/10 text-warn'
                    : 'border-ok/30 bg-ok/10 text-ok'
                  : 'border-line text-faint hover:text-dim',
              )}
            >
              {PERMISSION_LABELS[p]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
