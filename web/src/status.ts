import type { AgentStatus, RunPhase, TaskStatus } from '../../src/core/run-state.ts';
import type { Tone } from './ui.tsx';

export const AGENT_STATUS: Record<
  AgentStatus,
  { label: string; tone: Tone; dot: string; live: boolean }
> = {
  idle: { label: 'Idle', tone: 'neutral', dot: 'bg-faint', live: false },
  planning: { label: 'Planning', tone: 'violet', dot: 'bg-accent-2', live: true },
  working: { label: 'Working', tone: 'accent', dot: 'bg-accent', live: true },
  reviewing: { label: 'Reviewing', tone: 'violet', dot: 'bg-accent-2', live: true },
  waiting: { label: 'Waiting', tone: 'warn', dot: 'bg-warn', live: true },
  completed: { label: 'Completed', tone: 'ok', dot: 'bg-ok', live: false },
  failed: { label: 'Failed', tone: 'bad', dot: 'bg-bad', live: false },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone; color: string }> = {
  pending: { label: 'Pending', tone: 'neutral', color: '#5b6780' },
  running: { label: 'Running', tone: 'accent', color: '#7c9cff' },
  in_review: { label: 'In review', tone: 'violet', color: '#a78bfa' },
  waiting: { label: 'Waiting', tone: 'warn', color: '#fbbf24' },
  done: { label: 'Done', tone: 'ok', color: '#34d399' },
  failed: { label: 'Failed', tone: 'bad', color: '#f87171' },
  skipped: { label: 'Skipped', tone: 'neutral', color: '#3b4558' },
  cancelled: { label: 'Cancelled', tone: 'neutral', color: '#3b4558' },
};

export const RUN_PHASE: Record<RunPhase, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'accent' },
  paused: { label: 'Paused', tone: 'warn' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** A stable colour per layer, so an agent keeps its colour across views. */
const LAYER_COLORS = [
  '#7c9cff',
  '#a78bfa',
  '#34d399',
  '#f59e0b',
  '#38bdf8',
  '#f472b6',
  '#facc15',
  '#2dd4bf',
  '#fb7185',
];
export function layerColor(layers: string[], layer: string): string {
  const index = layers.indexOf(layer);
  return LAYER_COLORS[Math.max(index, 0) % LAYER_COLORS.length] ?? '#7c9cff';
}
