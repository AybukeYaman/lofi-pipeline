import type { ProjectWorkflow, WorkflowStepId, WorkflowStepInfo } from './types';

/**
 * Canonical kullanıcı akışı. Sıra ve tamamlanma durumu backend'den gelir
 * (project.workflow — diskteki kanıt); burada yalnızca adımın kullanıcıya
 * ne söyleyeceği durur.
 */
/**
 * Arayüzdeki adım kimlikleri. Sunucu 6 adım tutar (`music` ve `order` ayrı);
 * ekranda bu ikisi tek "Müzik ve sıralama" adımıdır — bkz. `viewWorkflow`.
 */
export type ViewStepId = Exclude<WorkflowStepId, 'order'>;

export const STEP_ORDER: ViewStepId[] = [
  'project',
  'video',
  'music',
  'build',
  'publish',
];

export const MUSIC_STEP_TITLE = 'Müzik ve sıralama';

/**
 * Sunucunun 6 adımlı akışını arayüzün 5 adımına indirir: `music` + `order`
 * birleşir, numaralar yeniden verilir. Arayüzün adım listesi, "İleri/Geri",
 * Projeler sayfasındaki "Adım: n/5" sayacı hep bu çıktıdan okur — iki yerde
 * iki farklı numara görünmesin. Shorts akışında (music/order yok) olduğu gibi döner.
 */
export function viewWorkflow(workflow: ProjectWorkflow | undefined): ProjectWorkflow | undefined {
  if (!workflow) return workflow;
  const music = workflow.steps.find((step) => step.id === 'music');
  const order = workflow.steps.find((step) => step.id === 'order');
  if (!music || !order) return workflow;

  const merged: WorkflowStepInfo = {
    ...music,
    title: MUSIC_STEP_TITLE,
    skipped: false,
    status:
      music.status === 'done' && order.status === 'done'
        ? 'done'
        : music.status === 'current' || order.status === 'current'
          ? 'current'
          : 'pending',
  };
  const steps = workflow.steps
    .filter((step) => step.id !== 'order')
    .map((step) => (step.id === 'music' ? merged : step))
    .map((step, index) => ({ ...step, number: index + 1 }));
  const onMusicStep = workflow.current === 'music' || workflow.current === 'order';
  return {
    ...workflow,
    current: onMusicStep ? 'music' : workflow.current,
    currentTitle: onMusicStep ? MUSIC_STEP_TITLE : workflow.currentTitle,
    steps,
  };
}

export const STEP_GUIDE: Record<ViewStepId, { who: 'user' | 'system'; lines: string[] }> = {
  project: {
    who: 'user',
    lines: ['Proje klasörü kuruldu. Ambiance ve Pomodoro 3. adımda (Müzik ve sıralama) seçilir.'],
  },
  video: {
    who: 'user',
    lines: ['Ürettiğin döngü klibini (.mp4) yükle veya videoda kalacak görseli seç.'],
  },
  music: {
    who: 'user',
    lines: [
      "Suno'dan parçaları üret ve buraya yükle.",
      'Sonra sırayı seç: eklediğin sırayla mı, kendi belirleyeceğin sırayla mı, alfabetik mi dizilsin?',
    ],
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

/** Kullanıcı yalnızca tamamlanmış adımlara ve ilk açık adıma gidebilir. `workflow` = `viewWorkflow` çıktısı. */
export function isStepReachable(workflow: ProjectWorkflow | undefined, id: ViewStepId): boolean {
  if (!workflow) return false;
  // `current` Shorts akışının adımı da olabilir; o ekran bu sihirbazı
  // kullanmıyor, listede olmayan değer -1 ile sonuçlanır (erişilemez).
  const currentIndex = STEP_ORDER.indexOf(workflow.current as ViewStepId);
  return STEP_ORDER.indexOf(id) <= currentIndex || stepInfo(workflow, id)?.status === 'done';
}

export function previousStep(id: ViewStepId): ViewStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index > 0 ? STEP_ORDER[index - 1] : null;
}

export function nextStepId(id: ViewStepId): ViewStepId | null {
  const index = STEP_ORDER.indexOf(id);
  return index >= 0 && index < STEP_ORDER.length - 1 ? STEP_ORDER[index + 1] : null;
}
