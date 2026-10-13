/** Web arayüzünün okuduğu kısım: hazır programlar, varsayılanlar ve zaman çizelgesi (tek kaynak core/pomodoro-plan.js). */

export type StepKind = 'work' | 'break';

/** Adım: bir çalışma ya da mola. */
export interface PlanStep {
  name: string;
  minutes: number;
  kind: StepKind;
  beep: boolean;
  visual: string | null;
}

/** Set: art arda gelen adımlar + kaç kez art arda uygulanacağı. */
export interface PlanSet {
  name: string;
  repeat: number;
  steps: PlanStep[];
}

/** `buildTimeline`'ın okuduğu plan alanları. */
export interface TimelinePlanInput {
  sets: ReadonlyArray<{ name: string; repeat: number; steps: ReadonlyArray<PlanStep> }>;
  rounds: number;
  intro?: { visual: string | null } | null;
}

export interface TimelineSession {
  index: number;
  kind: 'ready' | 'status';
  statusIndex: number;
  name: string;
  stepKind: 'ready' | StepKind;
  round: number;
  setIndex: number;
  setName: string | null;
  repeat: number;
  label: string;
  visual: string | null;
  beep: boolean;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
}

export function buildTimeline(plan: TimelinePlanInput): {
  sessions: TimelineSession[];
  totalSeconds: number;
  totalMinutes: number;
  /** Videoya girmeyen sondaki molalar: video hiçbir zaman molayla bitmez. */
  droppedTail: Array<{ name: string; minutes: number }>;
};

export function flattenSets(sets: ReadonlyArray<{ repeat: number; steps: ReadonlyArray<PlanStep> }>): PlanStep[];
export function inferKind(name: string): StepKind;
export function defaultSetName(index: number): string;
export function makeStep(name: string, minutes: number, extra?: Partial<PlanStep>): PlanStep;
export function makeSet(name: string, repeat: number, steps: PlanStep[]): PlanSet;

export const INTRO_SECONDS: number;
export const INTRO_NAME: string;
export const STATUS_NAME_MAX: number;

export const POMODORO_PRESETS: ReadonlyArray<{
  id: string;
  sets: ReadonlyArray<PlanSet>;
  /** Bir turun açılmış (set tekrarları dahil) adım listesi. */
  statuses: ReadonlyArray<PlanStep>;
}>;

export const POMODORO_DEFAULTS: {
  enabled: boolean;
  rounds: number;
  sets: ReadonlyArray<PlanSet>;
  statuses: ReadonlyArray<PlanStep>;
  countdownSeconds: number;
  countdownBeep: boolean;
  cue: { volumeDb: number; beepFile: string | null };
};

/** Saniye → `mm:ss` (dakika saate çevrilmez: `240:00`). */
export function formatClock(seconds: number): string;
