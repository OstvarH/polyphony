import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Coins,
  FileCode2,
  MessagesSquare,
  Pause,
  Play,
  Square,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Plan } from '../../../src/core/plan.ts';
import {
  type AgentState,
  applyEvent,
  type LogEntry,
  progress,
  type RunState,
} from '../../../src/core/run-state.ts';
import { api, money, type RunRecord, streamRun, tokens } from '../api.ts';
import { PlanGraph } from '../PlanGraph.tsx';
import { href } from '../router.ts';
import { AGENT_STATUS, layerColor, RUN_PHASE, TASK_STATUS } from '../status.ts';
import { Badge, Button, Card, cx, ErrorNote, Input, Meter, Spinner, Stat } from '../ui.tsx';

type Live = RunRecord & { state: RunState; live: boolean };

/** Holds the run state in a ref, applies streamed events, and re-renders at most once a frame. */
function useLiveRun(id: string) {
  const [run, setRun] = useState<Live | null>(null);
  const [, setVersion] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const state = useRef<RunState | null>(null);

  useEffect(() => {
    let close = () => {};
    let frame = 0;
    let cancelled = false;
    api.run(id).then((loaded) => {
      if (cancelled) return;
      state.current = loaded.state;
      setRun(loaded);
      // A finished run's stored state is final; only live runs need the stream.
      if (!loaded.live) return;
      close = streamRun(id, loaded.state.lastSeq, (event) => {
        if (!state.current) return;
        applyEvent(state.current, event);
        if (!frame) {
          frame = requestAnimationFrame(() => {
            frame = 0;
            setVersion((v) => v + 1);
          });
        }
      });
    }, setError);
    return () => {
      cancelled = true;
      close();
      cancelAnimationFrame(frame);
    };
  }, [id]);

  return { run, state: state.current, error };
}

export function RunPage({ id }: { id: string }) {
  const { run, state, error } = useLiveRun(id);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!run) return;
    api.project(run.projectId).then(
      (p) => setPlan(p.plans.find((x) => x.id === run.planId)?.plan ?? null),
      () => {},
    );
  }, [run]);

  if (error) return <ErrorNote error={error} />;
  if (!run || !state) return <Spinner label="Connecting to the run" />;

  const phase = RUN_PHASE[state.phase];
  const tasks = Object.values(state.tasks);
  const agents = Object.values(state.agents);
  const done = tasks.filter((t) => t.status === 'done').length;
  const active = state.phase === 'running' || state.phase === 'paused';
  const elapsed =
    ((state.endedAt ? new Date(state.endedAt).getTime() : now) -
      new Date(state.startedAt).getTime()) /
    1000;
  const budgetShare = state.budgetUsd > 0 ? state.cost / state.budgetUsd : 0;
  const statuses = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
  const openEscalations = state.escalations.filter((e) => e.answer === null);
  const pendingApprovals = state.approvals.filter((a) => a.decision === 'pending');
  const layers = plan?.layers.map((l) => l.id) ?? [...new Set(agents.map((a) => a.layer))];

  return (
    <div className="space-y-5">
      <a
        href={href({ page: 'project', id: run.projectId, tab: 'runs' })}
        className="inline-flex items-center gap-1.5 text-sm text-dim hover:text-ink"
      >
        <ArrowLeft className="size-4" /> Project
      </a>

      <Card className="overflow-hidden">
        {state.phase === 'running' && <div className="shimmer h-0.5" />}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <span
              className={cx(
                'relative grid size-9 place-items-center rounded-xl border',
                state.phase === 'running'
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-line bg-panel-2 text-dim',
              )}
            >
              <Activity className="size-4.5" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">Live orchestration</h1>
                <Badge tone={phase.tone}>{phase.label}</Badge>
              </div>
              <code className="text-[11px] text-faint">{run.id}</code>
            </div>
          </div>
          <RunControls
            runId={run.id}
            phase={state.phase}
            budget={state.budgetUsd}
            active={active && run.live}
          />
        </div>
        <div className="grid grid-cols-2 gap-5 border-t border-line px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Progress"
            value={`${done}/${tasks.length}`}
            sub={<Meter value={progress(state)} tone={state.phase === 'failed' ? 'bad' : 'ok'} />}
          />
          <Stat
            label="Elapsed"
            value={formatDuration(elapsed)}
            sub={`${agents.filter((a) => AGENT_STATUS[a.status].live).length} agents active`}
          />
          <Stat
            label="Spend"
            value={money(state.cost)}
            sub={
              state.unpricedCalls
                ? `+ ${state.unpricedCalls} unpriced calls`
                : state.budgetUsd
                  ? `of ${money(state.budgetUsd)}`
                  : 'no budget'
            }
          />
          <Stat
            label="Budget used"
            value={state.budgetUsd ? `${Math.round(budgetShare * 100)}%` : '—'}
            sub={
              <Meter
                value={budgetShare}
                tone={budgetShare > 0.9 ? 'bad' : budgetShare > 0.7 ? 'warn' : 'accent'}
              />
            }
          />
          <Stat
            label="Tokens"
            value={tokens(state.inputTokens + state.outputTokens)}
            sub={`${tokens(state.inputTokens)} in · ${tokens(state.outputTokens)} out`}
          />
          <Stat
            label="Messages"
            value={state.messages.length}
            sub={`${state.conflicts.length} conflicts`}
          />
        </div>
      </Card>

      {(openEscalations.length > 0 || pendingApprovals.length > 0) && (
        <div className="grid gap-3 lg:grid-cols-2">
          {openEscalations.map((e) => (
            <EscalationCard
              key={e.id}
              runId={run.id}
              escalation={e}
              agentName={state.agents[e.agent]?.name ?? e.agent}
            />
          ))}
          {pendingApprovals.map((a) => (
            <ApprovalCard
              key={a.id}
              runId={run.id}
              approval={a}
              agentName={state.agents[a.agent]?.name ?? a.agent}
            />
          ))}
        </div>
      )}

      <div className="grid gap-5 2xl:grid-cols-[1fr_1fr]">
        <Card
          title={
            <span className="flex items-center gap-2">
              <Bot className="size-4 text-accent" /> Agents
            </span>
          }
        >
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {orderAgents(agents).map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                color={layerColor(layers, agent.layer)}
                taskTitle={agent.currentTask ? state.tasks[agent.currentTask]?.title : undefined}
              />
            ))}
          </div>
        </Card>
        <Card title="Task graph" action={<Legend />}>
          <div className="p-3">
            {plan ? <PlanGraph plan={plan} statuses={statuses} height={520} /> : <Spinner />}
          </div>
        </Card>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <ActivityLog log={state.log} agents={state.agents} />
        <div className="space-y-5">
          <Messages state={state} />
          <Files state={state} />
        </div>
      </div>
    </div>
  );
}

function RunControls({
  runId,
  phase,
  budget,
  active,
}: {
  runId: string;
  phase: RunState['phase'];
  budget: number;
  active: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newBudget, setNewBudget] = useState(String(Math.max(budget * 2, 5)));
  const act = (name: string, action: () => Promise<unknown>) => async () => {
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
  if (!active) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {phase === 'paused' && (
        <div className="flex items-center gap-1.5">
          <Input
            value={newBudget}
            onChange={(e) => setNewBudget(e.target.value)}
            className="w-24 py-1.5 text-xs"
            aria-label="New budget in US dollars"
          />
          <Button
            icon={<Coins className="size-4" />}
            busy={busy === 'budget'}
            onClick={act('budget', () => api.setBudget(runId, Number(newBudget)))}
          >
            Set budget
          </Button>
        </div>
      )}
      {phase === 'running' ? (
        <Button
          icon={<Pause className="size-4" />}
          busy={busy === 'pause'}
          onClick={act('pause', () => api.pause(runId))}
        >
          Pause
        </Button>
      ) : (
        <Button
          variant="primary"
          icon={<Play className="size-4" />}
          busy={busy === 'resume'}
          onClick={act('resume', () => api.resume(runId))}
        >
          Resume
        </Button>
      )}
      <Button
        variant="danger"
        icon={<Square className="size-4" />}
        busy={busy === 'cancel'}
        onClick={act('cancel', () => api.cancel(runId))}
      >
        Cancel
      </Button>
      {error ? <ErrorNote error={error} /> : null}
    </div>
  );
}

function AgentCard({
  agent,
  color,
  taskTitle,
}: {
  agent: AgentState;
  color: string;
  taskTitle: string | undefined;
}) {
  const status = AGENT_STATUS[agent.status];
  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-xl border bg-bg/40 p-3.5 transition',
        status.live ? 'border-accent/30' : 'border-line',
        agent.parent && 'ml-4',
      )}
    >
      <div className="absolute inset-y-0 left-0 w-0.5" style={{ background: color }} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                'size-2 shrink-0 rounded-full',
                status.dot,
                status.live && 'pulse text-accent',
              )}
            />
            <span className="truncate text-sm font-semibold">{agent.name}</span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-faint">
            {agent.role}
            {agent.parent && ` · sub of ${agent.parent}`}
          </div>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px]">
        <span className="rounded bg-panel-2 px-1.5 py-0.5 font-mono text-dim">
          {agent.model ? agent.model.id : 'no model'}
        </span>
        {taskTitle && <span className="truncate text-accent">▸ {taskTitle}</span>}
      </div>
      <p className="mt-2 line-clamp-2 min-h-[2.4em] text-xs leading-snug text-dim">
        {agent.activity || (agent.status === 'idle' ? 'Waiting for a task.' : '')}
      </p>
      <div className="mt-2.5 grid grid-cols-4 gap-2 border-t border-line pt-2 text-[10.5px] text-faint">
        <span>
          <span className="block font-mono text-ink">
            {tokens(agent.inputTokens + agent.outputTokens)}
          </span>
          tokens
        </span>
        <span>
          <span className="block font-mono text-ink">{money(agent.cost)}</span>cost
        </span>
        <span>
          <span className="block font-mono text-ink">{agent.toolCalls}</span>tool calls
        </span>
        <span>
          <span className="block font-mono text-ink">{agent.tasksDone}</span>tasks done
        </span>
      </div>
    </div>
  );
}

function EscalationCard({
  runId,
  escalation,
  agentName,
}: {
  runId: string;
  escalation: RunState['escalations'][number];
  agentName: string;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-2xl border border-warn/40 bg-warn/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-warn">
        <AlertTriangle className="size-4" /> {agentName} needs a decision
      </div>
      <p className="mt-2 text-sm">{escalation.question}</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await api.answer(runId, escalation.id, answer).finally(() => setBusy(false));
        }}
      >
        <Input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="Your decision"
        />
        <Button type="submit" variant="primary" busy={busy} disabled={!answer.trim()}>
          Answer
        </Button>
      </form>
    </div>
  );
}

function ApprovalCard({
  runId,
  approval,
  agentName,
}: {
  runId: string;
  approval: RunState['approvals'][number];
  agentName: string;
}) {
  const [busy, setBusy] = useState(false);
  const decide = (approve: boolean) => async () => {
    setBusy(true);
    await api.approve(runId, approval.id, approve).finally(() => setBusy(false));
  };
  return (
    <div className="rounded-2xl border border-info/40 bg-info/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-info">
        <Terminal className="size-4" /> {agentName} wants to run a command
      </div>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-bg/80 p-2.5 font-mono text-xs text-ink">
        {approval.command}
      </pre>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="danger" onClick={decide(false)} busy={busy}>
          Deny
        </Button>
        <Button variant="primary" onClick={decide(true)} busy={busy}>
          Approve
        </Button>
      </div>
    </div>
  );
}

const KIND_STYLE: Record<LogEntry['kind'], { icon: typeof Activity; className: string }> = {
  info: { icon: Activity, className: 'text-dim' },
  tool: { icon: Wrench, className: 'text-info' },
  thought: { icon: Bot, className: 'text-ink' },
  message: { icon: MessagesSquare, className: 'text-accent-2' },
  warning: { icon: AlertTriangle, className: 'text-warn' },
  error: { icon: AlertTriangle, className: 'text-bad' },
  review: { icon: Activity, className: 'text-ok' },
};

function ActivityLog({ log, agents }: { log: LogEntry[]; agents: RunState['agents'] }) {
  const [agent, setAgent] = useState('');
  const [kind, setKind] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  // The log array is appended in place, so filter on every render rather than memoising on it.
  const shown = log
    .filter((l) => (!agent || l.agent === agent) && (!kind || l.kind === kind))
    .slice(-400);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-accent" /> Activity
        </span>
      }
      action={
        <div className="flex items-center gap-2 text-xs">
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="rounded border border-line bg-panel-2 px-1.5 py-1"
          >
            <option value="">All agents</option>
            {Object.values(agents).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded border border-line bg-panel-2 px-1.5 py-1"
          >
            <option value="">Everything</option>
            {Object.keys(KIND_STYLE).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-dim">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              className="accent-[#7c9cff]"
            />{' '}
            follow
          </label>
        </div>
      }
    >
      <div ref={box} className="h-[420px] overflow-y-auto px-3 py-2 font-mono text-[11.5px]">
        {shown.map((entry) => {
          const style = KIND_STYLE[entry.kind];
          const Icon = style.icon;
          return (
            <div
              key={`${entry.seq}-${entry.text.slice(0, 20)}`}
              className="flex gap-2 rounded px-1.5 py-1 hover:bg-panel-2/60"
            >
              <span className="shrink-0 text-faint">{entry.at.slice(11, 19)}</span>
              <Icon className={cx('mt-0.5 size-3.5 shrink-0', style.className)} />
              {entry.agent && (
                <span className="shrink-0 text-accent">
                  {agents[entry.agent]?.name ?? entry.agent}
                </span>
              )}
              <span className={cx('min-w-0 break-words', style.className)}>{entry.text}</span>
            </div>
          );
        })}
        {shown.length === 0 && <div className="p-4 text-faint">Nothing yet.</div>}
      </div>
    </Card>
  );
}

function Messages({ state }: { state: RunState }) {
  const messages = state.messages.slice(-50).reverse();
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <MessagesSquare className="size-4 text-accent-2" /> Agent messages
        </span>
      }
    >
      <div className="max-h-[220px] space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="text-xs text-faint">
            Agents talk to each other directly here: contracts, schemas, hand-offs.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="rounded-lg border border-line bg-bg/40 p-2.5 text-xs">
            <div className="mb-1 text-[11px] text-faint">
              <span className="text-accent">{state.agents[m.from]?.name ?? m.from}</span> →{' '}
              {m.to === '*' ? 'everyone' : (state.agents[m.to]?.name ?? m.to)}
            </div>
            <div className="text-dim">{m.text}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Files({ state }: { state: RunState }) {
  const files = Object.entries(state.files).sort((a, b) => b[1].at.localeCompare(a[1].at));
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <FileCode2 className="size-4 text-ok" /> Files written <Badge>{files.length}</Badge>
        </span>
      }
    >
      <div className="max-h-[220px] overflow-y-auto p-2">
        {files.length === 0 && <div className="p-2 text-xs text-faint">No files yet.</div>}
        {files.map(([path, info]) => (
          <div
            key={path}
            className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs hover:bg-panel-2"
          >
            <span className="truncate font-mono text-dim">{path}</span>
            <span className="shrink-0 text-faint">
              {state.agents[info.agent]?.name ?? info.agent}
            </span>
          </div>
        ))}
        {state.conflicts.map((c) => (
          <div
            key={`${c.path}${c.at}`}
            className="mt-1 rounded border border-warn/30 bg-warn/5 px-2 py-1 text-[11px] text-warn"
          >
            Conflict on {c.path}: {c.agents.join(' vs ')}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Legend() {
  return (
    <div className="hidden items-center gap-2.5 text-[10.5px] text-faint md:flex">
      {(['running', 'in_review', 'waiting', 'done', 'failed'] as const).map((s) => (
        <span key={s} className="flex items-center gap-1">
          <span className="size-2 rounded-full" style={{ background: TASK_STATUS[s].color }} />
          {TASK_STATUS[s].label}
        </span>
      ))}
    </div>
  );
}

/** Parents first, each followed by its subagents. */
function orderAgents(agents: AgentState[]): AgentState[] {
  const out: AgentState[] = [];
  for (const agent of agents.filter((a) => !a.parent)) {
    out.push(agent, ...agents.filter((a) => a.parent === agent.id));
  }
  return [...out, ...agents.filter((a) => !out.includes(a))];
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m ? `${m}m ${s}s` : `${s}s`;
}
