import {
  Background,
  Controls,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { useMemo } from 'react';
import { executionWaves, type Plan } from '../../src/core/plan.ts';
import type { TaskStatus } from '../../src/core/run-state.ts';
import { layerColor, TASK_STATUS } from './status.ts';

type TaskNodeData = {
  title: string;
  agent: string;
  color: string;
  status?: TaskStatus;
  reviewer?: string;
};

function TaskNode({ data }: NodeProps<Node<TaskNodeData>>) {
  const status = data.status ? TASK_STATUS[data.status] : undefined;
  const live =
    data.status === 'running' || data.status === 'in_review' || data.status === 'waiting';
  return (
    <div
      className="w-[210px] rounded-xl border bg-panel/95 px-3 py-2.5 shadow-lg"
      style={{
        borderColor: status ? `${status.color}88` : '#2a3850',
        boxShadow: live ? `0 0 0 1px ${status?.color}, 0 0 24px -6px ${status?.color}` : undefined,
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!size-2 !border-0 !bg-line-strong"
      />
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ background: data.color }} />
        <span className="truncate text-[12px] font-semibold text-ink">{data.title}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-dim">
        <span className="truncate">{data.agent}</span>
        {status && (
          <span className="shrink-0 font-medium" style={{ color: status.color }}>
            {status.label}
          </span>
        )}
      </div>
      {data.reviewer && (
        <div className="mt-1 truncate text-[10px] text-faint">review: {data.reviewer}</div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-2 !border-0 !bg-line-strong"
      />
    </div>
  );
}

const nodeTypes = { task: TaskNode };

/** The task dependency graph, laid out in parallel waves from left to right. */
export function PlanGraph({
  plan,
  statuses,
  height = 420,
}: {
  plan: Plan;
  statuses?: Record<string, TaskStatus>;
  height?: number;
}) {
  const { nodes, edges } = useMemo(() => {
    const layers = plan.layers.map((l) => l.id);
    const agents = new Map(plan.agents.map((a) => [a.id, a]));
    let waves: Plan['tasks'][] = [];
    try {
      waves = executionWaves(plan.tasks);
    } catch {
      waves = [plan.tasks];
    }
    const nodes: Node<TaskNodeData>[] = [];
    waves.forEach((wave, x) => {
      wave.forEach((task, y) => {
        const agent = agents.get(task.agent);
        const parentReviewer = agent?.parent;
        nodes.push({
          id: task.id,
          type: 'task',
          position: { x: x * 260, y: y * 104 - ((wave.length - 1) * 104) / 2 },
          data: {
            title: task.title,
            agent: agent?.name ?? task.agent,
            color: layerColor(layers, agent?.layer ?? ''),
            ...(statuses?.[task.id] ? { status: statuses[task.id] } : {}),
            ...(task.reviewer || parentReviewer
              ? { reviewer: task.reviewer ?? parentReviewer }
              : {}),
          },
          draggable: true,
        });
      });
    });
    const edges: Edge[] = plan.tasks.flatMap((task) =>
      task.dependsOn.map((dep) => {
        const active = statuses?.[task.id] === 'running';
        const done = statuses?.[dep] === 'done';
        return {
          id: `${dep}->${task.id}`,
          source: dep,
          target: task.id,
          animated: active,
          style: { stroke: done ? '#34d39988' : '#2a3850', strokeWidth: 1.5 },
        };
      }),
    );
    return { nodes, edges };
  }, [plan, statuses]);

  return (
    <div style={{ height }} className="overflow-hidden rounded-xl border border-line bg-bg/40">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1e2838" gap={22} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
