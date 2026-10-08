import type { ProjectWorkflow, WorkflowStepId, WorkflowStepInfo } from './types';

/**
 * Canonical kullanıcı akışı. Sıra ve tamamlanma durumu backend'den gelir
 * (project.workflow — diskteki kanıt); burada yalnızca adımın kullanıcıya
 * ne söyleyeceği durur.
 */
export const STEP_ORDER: WorkflowStepId[] = [
  'project',
  'video',
  'music',
  'order',
  'build',
  'publish',
];

export const STEP_GUIDE: Record<WorkflowStepId, { who: 'user' | 'system'; lines: string[] }> = {
  project: {
    who: 'user',
    lines: ['Proje adı, müzik stili ve ambient ses seçildi; proje ayarları hazırlandı.'],
  },
  video: {
    who: 'user',
    lines: ['Ürettiğin döngü klibini (.mp4) yükle veya videoda kalacak görseli seç.'],
  },
  music: {
    who: 'user',
    lines: ["Suno'dan parçaları üret ve buraya yükle."],
  },
  order: {
    who: 'user',
    lines: ['Parçalar eklediğin sırayla mı, kendi belirleyeceğin sırayla mı, alfabetik mi dizilsin?'],
  },
  build: {
    who: 'system',
    lines: [
      '"Başlat" de; kırpma, ses birleştirme, ambient, uzatma, fade ve tracklist otomatik.',
    ],
  },
  publish: {
    who: 'user',
    lines: ["YouTube'a yükle, bu metni açıklamaya yapıştır."],
  },
};

export function stepInfo(workflow: ProjectWorkflow | undefined, id: WorkflowStepId): WorkflowStepInfo | undefined {
  return workflow?.steps.find((step) => step.id === id);
}

/** Kullanıcı yalnızca tamamlanmış adımlara ve ilk açık adıma gidebilir. */
export function isStepReachable(workflow: ProjectWorkflow | undefined, id: WorkflowStepId): boolean {
  if (!workflow) return false;
  // `current` Shorts akışının adımı da olabilir; o ekran bu sihirbazı
  // kullanmıyor, listede olmayan değer -1 ile sonuçlanır (erişilemez).
  const currentIndex = STEP_ORDER.indexOf(workflow.current as WorkflowStepId);
  return STEP_ORDER.indexOf(id) <= currentIndex || stepInfo(workflow, id)?.status === 'done';
}

export function previousStep(id: WorkflowStepId): WorkflowStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index > 0 ? STEP_ORDER[index - 1] : null;
}

export function nextStepId(id: WorkflowStepId): WorkflowStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index >= 0 && index < STEP_ORDER.length - 1 ? STEP_ORDER[index + 1] : null;
}
