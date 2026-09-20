import type { ProjectWorkflow, WorkflowStepId, WorkflowStepInfo } from './types';

/**
 * Canonical kullanıcı akışı. Sıra ve tamamlanma durumu backend'den gelir
 * (project.workflow — diskteki kanıt); burada yalnızca adımın kullanıcıya
 * ne söyleyeceği durur.
 */
export const STEP_ORDER: WorkflowStepId[] = [
  'project',
  'style',
  'reference',
  'master',
  'angles',
  'video',
  'music',
  'order',
  'build',
  'publish',
];

export const STEP_GUIDE: Record<WorkflowStepId, { who: 'user' | 'system'; lines: string[] }> = {
  project: {
    who: 'user',
    lines: ['Proje adı, stil ve ambient ses seçildi; proje ayarları ve promptlar hazırlandı.'],
  },
  style: {
    who: 'user',
    lines: [
      'Beğendiğin bir stil görseli yükle; sistem görseli analiz edip stil tarifini kaydeder.',
      'Kayıtlı bir kütüphane stili seçtiysen bu adım tamamdır, yeniden görsel vermen gerekmez.',
    ],
  },
  reference: {
    who: 'user',
    lines: ['Sahnenin ne olacağını gösteren bir görsel bul ve yükle.'],
  },
  master: {
    who: 'user',
    lines: [
      "Bu promptu AI Studio'ya yapıştır.",
      'İki görseli yükle: biri sahne referansı, biri stil görseli.',
      'Görseli üret, en iyisini seç ve buraya yükle.',
    ],
  },
  angles: {
    who: 'user',
    lines: ['Farklı açılar ister misin? İstemiyorsan bu adımı atlayıp Video adımına geç.'],
  },
  video: {
    who: 'user',
    lines: [
      "Bu promptu Hailuo'ya yapıştır.",
      'Görseli yükle. 5 saniye, motion düşük kullan.',
      'Videoyu üret ve buraya yükle.',
    ],
  },
  music: {
    who: 'user',
    lines: ["Suno'dan parçaları üret ve buraya yükle."],
  },
  order: {
    who: 'user',
    lines: ['Sırayı kendin mi belirleyeceksin, alfabetik mi?'],
  },
  build: {
    who: 'system',
    lines: [
      '"Başlat" de; sistem watermark kırpma, 16:9 oran, ses birleştirme, ambient, videoyu ses süresine uzatma, fade ve tracklist işlemlerini otomatik yapar.',
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
  return STEP_ORDER.indexOf(id) <= STEP_ORDER.indexOf(workflow.current) || stepInfo(workflow, id)?.status === 'done';
}

export function previousStep(id: WorkflowStepId): WorkflowStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index > 0 ? STEP_ORDER[index - 1] : null;
}

export function nextStepId(id: WorkflowStepId): WorkflowStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index >= 0 && index < STEP_ORDER.length - 1 ? STEP_ORDER[index + 1] : null;
}
