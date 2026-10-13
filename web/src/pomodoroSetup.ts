/**
 * Pomodoro programının saf yardımcıları — `ProgramEditor` (proje formu ve ayar kutusu aynı
 * bileşeni kullanır), `ProgramPreview`, `StatusTabs` (Video adımı) ve testleri buradan okur.
 *
 * Üç kavram (core/pomodoro-plan.js ile aynı):
 *   ADIM  : bir çalışma ya da mola (ad, süre, tür, bip, görüntü)
 *   SET   : art arda gelen adımlar + kaç kez tekrar edeceği
 *   LOOP  : setlerin tamamı sırayla uygulanır, sonra başa döner (`rounds` kez)
 *
 * Önizleme ve toplamlar sunucudaki `buildTimeline`'ın KENDİSİNDEN gelir (aynı dosya import
 * edilir): ekranda görünen sıra, videoda ve bip/etiket planında uygulanan sıradır; arayüzde
 * ikinci bir süre hesabı yoktur.
 */

import {
  INTRO_SECONDS,
  STATUS_NAME_MAX,
  buildTimeline,
  defaultSetName,
  flattenSets,
  inferKind,
  makeSet,
  makeStep,
} from '../../core/pomodoro-plan.js';
import type {
  PomodoroProgram, PomodoroSession, PomodoroStatus, ProjectDetail, ProjectPomodoro, StepSet,
  UpdatePomodoroPayload,
} from './types';

/** Tur (LOOP tekrarı) düğmeleri. */
export const ROUND_CHOICES = [1, 2, 3, 4, 6];

/** Videonun başındaki GET READY oturumu (dk) — core/pomodoro-plan.js `INTRO_SECONDS`'tan. */
export const INTRO_MINUTES = INTRO_SECONDS / 60;

/** Ekranda yazan adın en uzun hâli — çekirdekten. */
export { STATUS_NAME_MAX };

/** Sunucu sınırları aynası: core/pomodoro-plan.js `RANGES` (orada dışa açık değil). */
export const MAX_SETS = 6;
export const MAX_STEPS_PER_SET = 8;
export const MAX_TOTAL_STEPS = 24;
export const MAX_REPEAT = 10;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

/** Süre için hazır düğmeler; başka bir değer elle yazılır. */
export const MINUTE_CHOICES = [5, 10, 15, 25, 30, 50];

/** "+ Adım ekle" sırayla bu adları önerir (kullanılmamış ilki); kullanıcı sonra değiştirir. */
export const STEP_SUGGESTIONS = ['STUDY', 'BREAK', 'LONG BREAK', 'STRETCH', 'WALK'];

/** GET READY sekmesinin anahtarı (durum adlarıyla karışmasın diye ayrı değer). */
export const INTRO_TAB = '__ready__';

export type EditableStep = PomodoroStatus;
export type EditableSet = StepSet;

/** Düzenleyicinin değeri: setler (program) ve LOOP'un kaç kez tekrar edeceği. */
export type PomodoroChoice = {
  sets: EditableSet[];
  rounds: number;
};

/** Yeni proje formunun başlangıç programı: SET 1 = STUDY 50 + BREAK 10. */
export function defaultSets(): EditableSet[] {
  return [makeSet(defaultSetName(0), 1, [makeStep('STUDY', 50), makeStep('BREAK', 10)])];
}

/**
 * Tarayıcıda saklanan form taslağından program: yeni taslak `sets`, eski taslak (bir önceki
 * sürüm) `statuses` taşır → tek set olur. Şekli bozuk taslak atılır (null: varsayılan kalır).
 * Görüntü taslakta tutulmaz (kurulumda zaten verilemiyor).
 */
export function choiceFromDraft(raw: unknown): PomodoroChoice | null {
  if (raw === null || typeof raw !== 'object') return null;
  const draft = raw as { sets?: unknown; statuses?: unknown; rounds?: unknown };
  const readSteps = (value: unknown): EditableStep[] | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const steps = value.map((item) => {
      const step = item as { name?: unknown; minutes?: unknown; beep?: unknown; kind?: unknown };
      if (typeof step?.name !== 'string' || !Number.isInteger(step.minutes)) return null;
      return makeStep(step.name, step.minutes as number, {
        beep: step.beep !== false,
        ...(step.kind === 'work' || step.kind === 'break' ? { kind: step.kind } : {}),
      });
    });
    return steps.every((step) => step !== null) ? steps as EditableStep[] : null;
  };

  let sets: EditableSet[] | null = null;
  if (Array.isArray(draft.sets) && draft.sets.length > 0) {
    const read = draft.sets.map((item, i) => {
      const set = item as { name?: unknown; repeat?: unknown; steps?: unknown };
      const steps = readSteps(set?.steps);
      if (!steps) return null;
      return makeSet(typeof set.name === 'string' ? set.name : defaultSetName(i), Number.isInteger(set.repeat) ? set.repeat as number : 1, steps);
    });
    if (read.every((set) => set !== null)) sets = read as EditableSet[];
  } else {
    const steps = readSteps(draft.statuses);
    if (steps) sets = [makeSet(defaultSetName(0), 1, steps)];
  }
  if (!sets) return null;
  return { sets, rounds: Number.isInteger(draft.rounds) ? draft.rounds as number : 2 };
}

// ------------------------------------------------------------ süre hesapları

/** Bir turun (bütün adımlar, set tekrarları dahil) dakikası. */
export function cycleMinutes(statuses: Array<{ minutes: number }>): number {
  return statuses.reduce((sum, status) => sum + status.minutes, 0);
}

/** Bir turun açılmış adım listesi (ad, süre, tür yeter): süre hesapları buna bakar. */
type FlatStep = Pick<PomodoroStatus, 'name' | 'minutes' | 'kind'>;

/**
 * Toplam video süresi (dakika): GET READY dahil, sondaki molalar HARİÇ (video molayla
 * bitmez). Müziğin doldurması gereken süre bu. Sunucunun `buildTimeline`'ından gelir.
 */
export function totalMinutes(statuses: FlatStep[], rounds: number): number {
  const steps = statuses.map((step) => makeStep(step.name, step.minutes, { kind: step.kind }));
  return buildTimeline({ sets: [makeSet(defaultSetName(0), 1, steps)], rounds, intro: { visual: null } }).totalMinutes;
}

/** Yalnızca turların süresi (dakika): GET READY hariç, sondaki molalar hariç. */
export function studyMinutes(statuses: FlatStep[], rounds: number): number {
  return totalMinutes(statuses, rounds) - INTRO_MINUTES;
}

/** 40 → "40 dk", 60 → "1 saat", 80 → "1 saat 20 dk", 240 → "4 saat". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} dk`;
  return rest === 0 ? `${hours} saat` : `${hours} saat ${rest} dk`;
}

/**
 * Program değişince video süresini olabildiğince korur: 2 saat 50/10 → 30/10'da 3 tur.
 * `previousStudyMinutes` GET READY HARİÇ turların süresidir.
 */
export function roundsKeepingTotal(previousStudyMinutes: number, statuses: Array<{ minutes: number }>): number {
  const cycle = cycleMinutes(statuses);
  if (cycle <= 0) return 1;
  return Math.min(24, Math.max(1, Math.round(previousStudyMinutes / cycle)));
}

/** Tur düğmeleri: sabit liste + elle yazılmış (eski proje) bir değer varsa o da görünür. */
export function roundChoicesFor(current: number): number[] {
  return ROUND_CHOICES.includes(current)
    ? ROUND_CHOICES
    : [...ROUND_CHOICES, current].sort((a, b) => a - b);
}

/** "50/10/50/20 · 5 saat 22 dk · 2 tur" — başlık çipi ve özet satırları aynı cümleyi kullanır. */
export function pomodoroSummary(statuses: FlatStep[], rounds: number): string {
  const cycle = statuses.map((status) => status.minutes).join('/');
  return `${cycle} · ${durationLabel(totalMinutes(statuses, rounds))} · ${rounds} tur`;
}

// ------------------------------------------------------------ set / adım düzenleme

/** Bir turdaki toplam adım sayısı (set tekrarları dahil). */
export function totalSteps(sets: EditableSet[]): number {
  return flattenSets(sets).length;
}

/** Yeni adım eklenebilir mi: setin ve turun sınırları. */
export function canAddStep(sets: EditableSet[], setIndex: number): boolean {
  const set = sets[setIndex];
  if (!set) return false;
  return set.steps.length < MAX_STEPS_PER_SET && totalSteps(sets) + set.repeat <= MAX_TOTAL_STEPS;
}

/** Yeni set eklenebilir mi. */
export function canAddSet(sets: EditableSet[]): boolean {
  return sets.length < MAX_SETS && totalSteps(sets) + 1 <= MAX_TOTAL_STEPS;
}

/** Tekrar sayısı bu değere çekilebilir mi: tur toplamı sınırı aşılmasın. */
export function canRepeat(sets: EditableSet[], setIndex: number, repeat: number): boolean {
  const set = sets[setIndex];
  if (!set || repeat < 1 || repeat > MAX_REPEAT) return false;
  return totalSteps(sets) - set.steps.length * set.repeat + set.steps.length * repeat <= MAX_TOTAL_STEPS;
}

/** Yeni adım: kullanılmamış ilk öneri adıyla, 10 dk, bip açık, ana görüntü. */
export function addStep(sets: EditableSet[], setIndex: number): EditableSet[] {
  if (!canAddStep(sets, setIndex)) return sets;
  const used = new Set(sets[setIndex].steps.map((step) => step.name.toLowerCase()));
  const name = STEP_SUGGESTIONS.find((candidate) => !used.has(candidate.toLowerCase())) ?? 'NEW';
  return sets.map((set, i) => (i === setIndex ? { ...set, steps: [...set.steps, makeStep(name, 10)] } : set));
}

/** Yeni set: bir sonraki SET adıyla, tek çalışma adımı (süre: programdaki son çalışmanın süresi). */
export function addSet(sets: EditableSet[]): EditableSet[] {
  if (!canAddSet(sets)) return sets;
  const lastWork = [...(flattenSets(sets) as EditableStep[])].reverse().find((step) => step.kind === 'work');
  return [...sets, makeSet(defaultSetName(sets.length), 1, [makeStep('STUDY', lastWork?.minutes ?? 25)])];
}

/** Varsayılan adlı setler ("SET 3") sıra değişince yeni sıra numarasını alır; elle yazılmış adlar korunur. */
function renumberDefaultNames(before: EditableSet[], after: EditableSet[]): EditableSet[] {
  const wasDefault = new Map(before.map((set, i) => [set, set.name === defaultSetName(i)]));
  return after.map((set, i) => (wasDefault.get(set) ? { ...set, name: defaultSetName(i) } : set));
}

/** Seti siler; en az bir set kalır. Kalan setlerin `SET n` varsayılan adları yeniden numaralanır. */
export function removeSet(sets: EditableSet[], setIndex: number): EditableSet[] {
  if (sets.length <= 1) return sets;
  return renumberDefaultNames(sets, sets.filter((_, i) => i !== setIndex));
}

/** Seti `from` sırasından `to` sırasına taşır; varsayılan adlar yeni sıraya göre numaralanır. */
export function moveSet(sets: EditableSet[], from: number, to: number): EditableSet[] {
  if (from === to || from < 0 || to < 0 || from >= sets.length || to >= sets.length) return sets;
  const next = [...sets];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return renumberDefaultNames(sets, next);
}

/** Set adını ya da tekrarını günceller (ad uzunluğa kıstırılır; tur sınırını aşan tekrar yok sayılır). */
export function updateSet(
  sets: EditableSet[],
  setIndex: number,
  changes: Partial<Pick<EditableSet, 'name' | 'repeat'>>,
): EditableSet[] {
  return sets.map((set, i) => {
    if (i !== setIndex) return set;
    const next = { ...set };
    if (changes.name !== undefined) next.name = changes.name.replace(/[\r\n]+/g, ' ').slice(0, STATUS_NAME_MAX);
    if (changes.repeat !== undefined) {
      const repeat = Math.round(changes.repeat);
      if (canRepeat(sets, setIndex, repeat)) next.repeat = repeat;
    }
    return next;
  });
}

/** Adımı siler; her sette en az bir adım kalır. */
export function removeStep(sets: EditableSet[], setIndex: number, stepIndex: number): EditableSet[] {
  if (!sets[setIndex] || sets[setIndex].steps.length <= 1) return sets;
  return sets.map((set, i) => (
    i === setIndex ? { ...set, steps: set.steps.filter((_, j) => j !== stepIndex) } : set
  ));
}

/** Konum: hangi sette, kaçıncı adım. */
export type StepPosition = { set: number; step: number };

/**
 * Adımı bir konumdan başka bir konuma taşır — aynı set içinde de, başka sete de (sürükle-bırak
 * ve ↑/↓ tuşları aynı işlevi kullanır). Hedef set doluysa, kaynak setin tek adımı kalmışsa ya da
 * tur sınırı aşılacaksa liste değişmez.
 */
export function moveStep(sets: EditableSet[], from: StepPosition, to: StepPosition): EditableSet[] {
  const source = sets[from.set];
  const target = sets[to.set];
  if (!source || !target || !source.steps[from.step]) return sets;
  if (from.set === to.set && from.step === to.step) return sets;
  if (from.set !== to.set) {
    if (source.steps.length <= 1 || target.steps.length >= MAX_STEPS_PER_SET) return sets;
    if (totalSteps(sets) - source.repeat + target.repeat > MAX_TOTAL_STEPS) return sets;
  }

  const moved = source.steps[from.step];
  const next = sets.map((set) => ({ ...set, steps: [...set.steps] }));
  next[from.set].steps.splice(from.step, 1);
  const index = Math.max(0, Math.min(to.step, next[to.set].steps.length));
  next[to.set].steps.splice(index, 0, moved);
  return next;
}

/**
 * Adımın alanlarını günceller: süre sınırlara, ad uzunluğa kıstırılır. Adı değişince, tür
 * eski addan tahmin edilmişse (kullanıcı elle seçmediyse) yeni addan yeniden tahmin edilir.
 */
export function updateStep(
  sets: EditableSet[],
  setIndex: number,
  stepIndex: number,
  changes: Partial<Pick<EditableStep, 'name' | 'minutes' | 'beep' | 'kind'>>,
): EditableSet[] {
  return sets.map((set, i) => {
    if (i !== setIndex) return set;
    return {
      ...set,
      steps: set.steps.map((step, j) => {
        if (j !== stepIndex) return step;
        const next = { ...step, ...changes };
        if (changes.minutes !== undefined) {
          const minutes = Number.isFinite(changes.minutes) ? Math.round(changes.minutes) : step.minutes;
          next.minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
        }
        if (changes.name !== undefined) {
          next.name = changes.name.replace(/[\r\n]+/g, ' ').slice(0, STATUS_NAME_MAX);
          if (changes.kind === undefined && step.kind === inferKind(step.name)) next.kind = inferKind(next.name);
        }
        return next;
      }),
    };
  });
}

/** Ad boş bırakılmış bir adım ya da set var mı (kaydetmeden önce kullanıcıya söylenir). */
export function hasEmptyName(sets: EditableSet[]): boolean {
  return sets.some((set) => set.name.trim() === '' || set.steps.some((step) => step.name.trim() === ''));
}

// ------------------------------------------------------------ hazır/kayıtlı programlar

type ProgramShape = Array<Pick<StepSet, 'name' | 'repeat'> & {
  steps: Array<Pick<EditableStep, 'name' | 'minutes' | 'beep' | 'kind'>>;
}>;

/** Program (set yapısı) birebir aynı mı — set adı, tekrar, adım adı/süresi/türü/bipi; görüntü karşılaştırılmaz. */
export function sameProgram(a: EditableSet[], b: ProgramShape): boolean {
  return a.length === b.length && a.every((set, i) => (
    set.name === b[i].name
    && set.repeat === b[i].repeat
    && set.steps.length === b[i].steps.length
    && set.steps.every((step, j) => (
      step.name === b[i].steps[j].name
      && step.minutes === b[i].steps[j].minutes
      && step.beep === b[i].steps[j].beep
      && step.kind === b[i].steps[j].kind
    ))
  ));
}

/** Listeye uyan ilk hazır/kayıtlı program (hazırlar önce gelir); yoksa null. */
export function matchingProgram(sets: EditableSet[], programs: PomodoroProgram[]): PomodoroProgram | null {
  return programs.find((program) => !program.error && sameProgram(sets, program.sets)) ?? null;
}

/**
 * Programdan yeni setler: görüntüler programa girmez, bu yüzden aynı adlı adımın mevcut
 * görüntüsü korunur (program seçmek görüntüleri silmesin).
 */
export function setsFromProgram(program: PomodoroProgram, current: EditableSet[]): EditableSet[] {
  const visuals = new Map<string, string | null>();
  for (const step of flattenSets(current) as EditableStep[]) {
    if (!visuals.has(step.name)) visuals.set(step.name, step.visual);
  }
  return program.sets.map((set) => ({
    name: set.name,
    repeat: set.repeat,
    steps: set.steps.map((step) => ({ ...step, visual: visuals.get(step.name) ?? null })),
  }));
}

// ------------------------------------------------------------ önizleme ve anlatım

/** Programın gerçek oturumları — sunucunun `buildTimeline`'ı (GET READY dahil, sondaki molalar hariç). */
export function programSessions(sets: EditableSet[], rounds: number): PomodoroSession[] {
  return buildTimeline({ sets, rounds, intro: { visual: null } }).sessions as PomodoroSession[];
}

/** Videoya girmeyen sondaki molalar (video molayla bitmez) — `buildTimeline`'dan. */
export function droppedTail(sets: EditableSet[], rounds: number): Array<{ name: string; minutes: number }> {
  return buildTimeline({ sets, rounds, intro: { visual: null } }).droppedTail;
}

/** Toplamlar: çalışma/mola adedi ve süreleri, GET READY, video süresi. */
export type ProgramStats = {
  workCount: number;
  breakCount: number;
  workMinutes: number;
  breakMinutes: number;
  introMinutes: number;
  totalMinutes: number;
  stepsPerRound: number;
};

export function programStats(sets: EditableSet[], rounds: number): ProgramStats {
  const sessions = programSessions(sets, rounds).filter((session) => session.kind === 'status');
  const work = sessions.filter((session) => session.stepKind === 'work');
  const breaks = sessions.filter((session) => session.stepKind === 'break');
  const minutes = (list: PomodoroSession[]) => list.reduce((sum, session) => sum + session.durationSeconds / 60, 0);
  return {
    workCount: work.length,
    breakCount: breaks.length,
    workMinutes: minutes(work),
    breakMinutes: minutes(breaks),
    introMinutes: INTRO_MINUTES,
    totalMinutes: INTRO_MINUTES + minutes(sessions),
    stepsPerRound: totalSteps(sets),
  };
}

/**
 * Programı doğal dille anlatır (ilk turdan): hangi çalışmadan sonra hangi mola gelir, set
 * sırası kaç kez uygulanır, program ne zaman biter. Sayılar `programStats`/timeline'dan gelir.
 */
export function describeProgram(sets: EditableSet[], rounds: number): string[] {
  const flat = flattenSets(sets) as EditableStep[];
  const lines: string[] = [];

  let workNumber = 0;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i].kind !== 'work') continue;
    workNumber += 1;
    const breaks: EditableStep[] = [];
    for (let j = i + 1; j < flat.length && flat[j].kind === 'break'; j++) breaks.push(flat[j]);
    const rest = breaks.map((step) => `${step.minutes} dk ${step.name}`).join(' + ');
    lines.push(
      rest
        ? `${workNumber}. çalışma (${flat[i].minutes} dk) bitince ${rest} verilir.`
        : `${workNumber}. çalışma (${flat[i].minutes} dk) bitince doğrudan sonraki adıma geçilir.`,
    );
  }

  const stats = programStats(sets, rounds);
  lines.push(
    rounds > 1
      ? `Bu set sırası toplam ${rounds} kez uygulanacak.`
      : 'Bu set sırası bir kez uygulanacak.',
    `Program ${stats.workCount} çalışma adımından sonra sona erecek.`,
  );
  const dropped = droppedTail(sets, rounds);
  if (dropped.length > 0) {
    const rest = dropped.map((step) => `${step.minutes} dk ${step.name}`).join(' + ');
    lines.push(`Video çalışmayla biter: en sondaki ${rest} videoya girmez.`);
  }
  return lines;
}

/** Programdaki tuhaflıklar (engel değil, uyarı): kullanıcı bilerek yapmış olabilir ama haberi olsun. */
export function programWarnings(sets: EditableSet[]): string[] {
  const flat = flattenSets(sets) as EditableStep[];
  const warnings: string[] = [];
  if (!flat.some((step) => step.kind === 'work')) {
    warnings.push('Hiç çalışma adımı yok: tüm adımlar mola sayılıyor. Bir adımı “Çalışma” olarak işaretle.');
  }
  if (flat[0]?.kind === 'break') {
    warnings.push(`Program ${flat[0].name} ile, yani moladan başlıyor.`);
  }
  for (let i = 1; i < flat.length; i++) {
    if (flat[i].kind === 'break' && flat[i - 1].kind === 'break') {
      warnings.push(`${flat[i - 1].name} ve ${flat[i].name} arka arkaya iki mola: istediğin bu mu?`);
      break;
    }
  }
  return warnings;
}

// ------------------------------------------------------------ Video adımı sekmeleri

/** Sekme: GET READY ya da aynı adlı adımların topluluğu (ikisi de tek görüntüyü paylaşır). */
export type StatusTab = { key: string; label: string };

/** `GET READY | STUDY | BREAK | …` — aynı adlı adımlar tek sekmede (adlar bir turun açılmış listesinden). */
export function statusTabs(statuses: Array<{ name: string }>): StatusTab[] {
  const seen = new Set<string>();
  const tabs: StatusTab[] = [{ key: INTRO_TAB, label: 'GET READY' }];
  for (const status of statuses) {
    if (seen.has(status.name)) continue;
    seen.add(status.name);
    tabs.push({ key: status.name, label: status.name });
  }
  return tabs;
}

/** Sekmenin kayıtlı görüntüsü (yoksa null → ana görüntüyle aynı). */
export function visualOfTab(
  tabKey: string,
  statuses: Array<{ name: string; visual: string | null }>,
  intro: { visual: string | null },
): string | null {
  if (tabKey === INTRO_TAB) return intro.visual;
  return statuses.find((status) => status.name === tabKey)?.visual ?? null;
}

/** Sekmenin görüntüsünü ayarlar: aynı adlı BÜTÜN adımlar (her sette) birlikte güncellenir. */
export function withTabVisual(
  tabKey: string,
  visual: string | null,
  sets: EditableSet[],
  intro: { visual: string | null },
): { sets: EditableSet[]; intro: { visual: string | null } } {
  if (tabKey === INTRO_TAB) return { sets, intro: { visual } };
  return {
    sets: sets.map((set) => ({
      ...set,
      steps: set.steps.map((step) => (step.name === tabKey ? { ...step, visual } : step)),
    })),
    intro,
  };
}

// ------------------------------------------------------------ sunucu gövdesi

/** "./resimler/a.png" → "resimler/a.png": adaylarla kayıtlı yol aynı biçimde karşılaşsın. */
export const bareVisual = (path: string): string => path.replace(/^\.\//, '');

/** Sunucuya giden setler: görüntü yoksa alan hiç gönderilmez, bip açıksa yazılmaz; tür açıkça gider. */
export function setsPayload(sets: EditableSet[]): NonNullable<UpdatePomodoroPayload['sets']> {
  return sets.map((set) => ({
    name: set.name.trim(),
    repeat: set.repeat,
    steps: set.steps.map((step) => ({
      name: step.name.trim(),
      minutes: step.minutes,
      kind: step.kind,
      ...(step.beep ? {} : { beep: false }),
      ...(step.visual ? { visual: step.visual } : {}),
    })),
  }));
}

/**
 * Proje durumundan (`readiness.pomodoro`) sunucuya gidecek tam gövde — Video adımı ayrı
 * bir istekle ayarı (parça süresi ölçen ağır uç) okumak zorunda kalmasın diye.
 */
export function readinessPayload(
  current: NonNullable<ProjectDetail['readiness']['pomodoro']>,
  changes: Partial<UpdatePomodoroPayload> = {},
): UpdatePomodoroPayload {
  return {
    enabled: true,
    rounds: current.rounds ?? 1,
    sets: setsPayload(current.sets ?? []),
    ...(current.intro?.visual ? { intro: { visual: current.intro.visual } } : {}),
    countdownBeep: current.countdownBeep ?? true,
    ...changes,
  };
}

/**
 * Sunucuya gidecek tam gövde: ekranın bütün alanları her seferinde birlikte gider
 * (PUT eksik alanı varsayılana çevirir). Ayar kutusu da görüntü sekmeleri de
 * bunu kullanır — biri yazarken öbürünün alanı kaybolmasın.
 */
export function pomodoroPayload(
  data: ProjectPomodoro,
  changes: Partial<UpdatePomodoroPayload> = {},
): UpdatePomodoroPayload {
  const current = data.settings;
  return {
    enabled: true,
    rounds: current?.rounds ?? data.defaults.rounds,
    sets: setsPayload(current?.sets ?? data.defaults.sets),
    ...(current?.intro.visual ? { intro: { visual: current.intro.visual } } : {}),
    countdownBeep: current?.countdownBeep ?? data.defaults.countdownBeep,
    ...changes,
  };
}
