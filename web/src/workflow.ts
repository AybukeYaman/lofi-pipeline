import type { ProjectReadiness } from './types';

export const workflowSteps = [
  { id: 'faz1', label: 'Style / References', section: 'style' },
  { id: 'faz2', label: 'Master Frame', section: 'master' },
  { id: 'faz3', label: 'Video Clip', section: 'video' },
  { id: 'audio', label: 'Music', section: 'music' },
  { id: 'build', label: 'Build', section: 'build' },
  { id: 'done', label: 'Completed', section: 'completed' },
] as const;

const stepOrder = ['style-references', 'faz1', 'faz2', 'faz3', 'clip', 'audio', 'build', 'done'];
const sectionByStep: Record<string, string> = {
  'style-references': 'style',
  faz1: 'master',
  faz2: 'master',
  faz3: 'video',
  clip: 'video',
  audio: 'music',
  build: 'build',
  done: 'completed',
};

export type WorkflowStatus = 'completed' | 'current' | 'pending' | 'unavailable';

export function sectionForStep(stepId?: string) {
  return stepId ? sectionByStep[stepId] ?? 'style' : 'style';
}

export function getWorkflowStatus(
  section: string,
  currentStepId?: string,
  readiness?: ProjectReadiness,
): WorkflowStatus {
  if (!currentStepId) return 'unavailable';
  if (currentStepId === 'done') return section === 'completed' ? 'current' : 'completed';

  const currentSection = sectionForStep(currentStepId);
  const sectionOrder = workflowSteps.findIndex((step) => step.section === section);
  const currentOrder = workflowSteps.findIndex((step) => step.section === currentSection);

  if (sectionOrder === -1 || currentOrder === -1 || stepOrder.indexOf(currentStepId) === -1) {
    return 'unavailable';
  }

  if (sectionOrder === currentOrder) {
    return 'current';
  }

  if (readiness) {
    const isStageReady = getStageReadiness(section, readiness);
    if (sectionOrder < currentOrder) {
      return isStageReady ? 'completed' : 'pending';
    }
    return isStageReady ? 'completed' : 'pending';
  }

  if (sectionOrder < currentOrder) return 'completed';
  return 'pending';
}

function getStageReadiness(section: string, readiness: ProjectReadiness): boolean {
  switch (section) {
    case 'style':
      return readiness.style.ready;
    case 'master':
      return readiness.master.ready;
    case 'video':
      return readiness.clip.ready;
    case 'music':
      return readiness.music.ready;
    case 'build':
      return readiness.build.ready;
    case 'completed':
      return readiness.output.exists;
    default:
      return false;
  }
}

