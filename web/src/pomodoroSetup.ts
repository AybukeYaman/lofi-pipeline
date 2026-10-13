/**
 * Pomodoro durum listesinin saf yardımcıları — `StatusEditor` (proje formu ve ayar
 * kutusu aynı bileşeni kullanır), `StatusTabs` (Video adımı) ve testleri buradan okur.
 *
 * Kullanıcı "2 saatlik video" diye düşünüyor, sistem tur sayısıyla çalışıyor:
 * süre ↔ tur çevirisi ve liste düzenleme (ekle/sil/taşı) tek yerde durur, hiçbir
 * ekran kendi hesabını yapmaz. Gerçek timeline hesabı sunucuda
 * (core/pomodoro-plan.js `buildTimeline`); buradaki yalnızca düğme etiketleri için
 * basit toplama.
 *
 * Her Pomodoro videosu 2 dakikalık bir GET READY ile başlar (`INTRO_MINUTES`,
 * sunucudaki `INTRO_SECONDS` aynası); "video süresi" düğmeleri yalnızca döngüleri gösterir.
 */

import type {
  PomodoroSet, PomodoroStatus, ProjectDetail, ProjectPomodoro, UpdatePomodoroPayload,
} from './types';

/** Tur düğmeleri: her biri toplam süre etiketiyle gösterilir. */
export const ROUND_CHOICES = [1, 2, 3, 4, 6];

/** Videonun başındaki GET READY oturumu (dk) — core/pomodoro-plan.js `INTRO_SECONDS` aynası. */
export const INTRO_MINUTES = 2;

/** Sunucu sınırları aynası: core/pomodoro-plan.js `RANGES.statusCount`, `STATUS_NAME_MAX`, `RANGES.minutes`. */
export const MAX_STATUSES = 8;
export const STATUS_NAME_MAX = 24;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

/** Süre için hazır düğmeler; başka bir değer elle yazılır. */
export const MINUTE_CHOICES = [5, 10, 15, 25, 30, 50];

/** "+ Durum ekle" sırayla bu adları önerir (kullanılmamış ilki); kullanıcı sonra değiştirir. */
export const STATUS_SUGGESTIONS = ['STRETCH', 'LONG BREAK', 'WALK', 'SNACK', 'REVIEW'];

/** GET READY sekmesinin anahtarı (durum adlarıyla karışmasın diye boşluklu/küçük harfli değil, ayrı alan). */
export const INTRO_TAB = '__ready__';

/** Ekranda düzenlenen durum: kayıtlı görüntüsüyle birlikte (yeni projede görüntü hep null). */
export type EditableStatus = PomodoroStatus;

/** Düzenleyicinin değeri. */
export type PomodoroChoice = {
  statuses: EditableStatus[];
  rounds: number;
};

/** Bir turun (bütün durumlar) dakikası. */
export function cycleMinutes(statuses: Array<{ minutes: number }>): number {
  return statuses.reduce((sum, status) => sum + status.minutes, 0);
}

/** Yalnızca turların süresi (dakika) — düğmelerde "2 saat" diye görünen. */
export function studyMinutes(statuses: Array<{ minutes: number }>, rounds: number): number {
  return cycleMinutes(statuses) * rounds;
}

/** Toplam video süresi (dakika): GET READY dahil. Müziğin doldurması gereken süre bu. */
export function totalMinutes(statuses: Array<{ minutes: number }>, rounds: number): number {
  return INTRO_MINUTES + studyMinutes(statuses, rounds);
}

/** 40 → "40 dk", 60 → "1 saat", 80 → "1 saat 20 dk", 240 → "4 saat". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} dk`;
  return rest === 0 ? `${hours} saat` : `${hours} saat ${rest} dk`;
}

/**
 * Liste değişince çalışma süresini olabildiğince korur: 2 saat 50/10 → 30/10'da 3 tur (yine 2 saat).
 * `previousStudyMinutes` GET READY HARİÇ turların süresidir (`studyMinutes`).
 */
export function roundsKeepingTotal(
  previousStudyMinutes: number,
  statuses: Array<{ minutes: number }>,
): number {
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

/** "50/10 · 2 saat 2 dk · 2 tur" — başlık çipi ve özet satırları aynı cümleyi kullanır. */
export function pomodoroSummary(statuses: Array<{ minutes: number }>, rounds: number): string {
  const cycle = statuses.map((status) => status.minutes).join('/');
  return `${cycle} · ${durationLabel(totalMinutes(statuses, rounds))} · ${rounds} tur`;
}

// ------------------------------------------------------------ liste düzenleme

/** Yeni durum satırı: kullanılmamış ilk öneri adıyla, 10 dk, bip açık, ana görüntü. */
export function addStatus(statuses: EditableStatus[]): EditableStatus[] {
  if (statuses.length >= MAX_STATUSES) return statuses;
  const used = new Set(statuses.map((status) => status.name.toLowerCase()));
  const name = STATUS_SUGGESTIONS.find((candidate) => !used.has(candidate.toLowerCase())) ?? 'NEW';
  return [...statuses, { name, minutes: 10, beep: true, visual: null }];
}

/** Satırı siler; en az bir durum kalır. */
export function removeStatus(statuses: EditableStatus[], index: number): EditableStatus[] {
  if (statuses.length <= 1) return statuses;
  return statuses.filter((_, i) => i !== index);
}

/** Satırı `from` sırasından `to` sırasına taşır (sürükle-bırak ve ↑/↓ düğmeleri aynı işlevi kullanır). */
export function moveStatus(statuses: EditableStatus[], from: number, to: number): EditableStatus[] {
  if (from === to || from < 0 || to < 0 || from >= statuses.length || to >= statuses.length) return statuses;
  const next = [...statuses];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Bir satırın alanlarını günceller; süre sınırlara, ad uzunluk sınırına kıstırılır. */
export function updateStatus(
  statuses: EditableStatus[],
  index: number,
  changes: Partial<Pick<EditableStatus, 'name' | 'minutes' | 'beep'>>,
): EditableStatus[] {
  return statuses.map((status, i) => {
    if (i !== index) return status;
    const next = { ...status, ...changes };
    if (changes.minutes !== undefined) {
      const minutes = Number.isFinite(changes.minutes) ? Math.round(changes.minutes) : status.minutes;
      next.minutes = Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes));
    }
    if (changes.name !== undefined) {
      next.name = changes.name.replace(/[\r\n]+/g, ' ').slice(0, STATUS_NAME_MAX);
    }
    return next;
  });
}

/** Ad boş bırakılmış mı (kaydetmeden önce kullanıcıya söylenir). */
export function hasEmptyName(statuses: Array<{ name: string }>): boolean {
  return statuses.some((status) => status.name.trim() === '');
}

// ------------------------------------------------------------ kayıtlı setler

/** Liste bir sete (ad, dakika, bip) birebir uyuyor mu — görüntü karşılaştırılmaz. */
export function sameCycle(
  statuses: Array<{ name: string; minutes: number; beep: boolean }>,
  set: Pick<PomodoroSet, 'statuses'>,
): boolean {
  return statuses.length === set.statuses.length
    && statuses.every((status, i) => (
      status.name === set.statuses[i].name
      && status.minutes === set.statuses[i].minutes
      && status.beep === set.statuses[i].beep
    ));
}

/** Listeye uyan ilk set (hazır düzenler önce gelir); yoksa null. */
export function matchingSet(
  statuses: Array<{ name: string; minutes: number; beep: boolean }>,
  sets: PomodoroSet[],
): PomodoroSet | null {
  return sets.find((set) => !set.error && sameCycle(statuses, set)) ?? null;
}

/** Setin durumlarından yeni liste: görüntüler korunmaz, sete girmemişti (aynı sıradaki durumun görüntüsü kalır). */
export function statusesFromSet(set: PomodoroSet, current: EditableStatus[]): EditableStatus[] {
  return set.statuses.map((status, i) => ({
    name: status.name,
    minutes: status.minutes,
    beep: status.beep,
    // Aynı adlı durumun kayıtlı görüntüsü yeni listede de kalsın: set seçmek görüntüleri silmesin.
    visual: current.find((item) => item.name === status.name)?.visual ?? current[i]?.visual ?? null,
  }));
}

// ------------------------------------------------------------ Video adımı sekmeleri

/** Sekme: GET READY ya da aynı adlı durumların topluluğu (ikisi de tek görüntüyü paylaşır). */
export type StatusTab = { key: string; label: string };

/** `GET READY | STUDY | BREAK | …` — aynı adlı durumlar tek sekmede. */
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

/** Sekmenin görüntüsünü ayarlar: aynı adlı BÜTÜN durumlar birlikte güncellenir. */
export function withTabVisual(
  tabKey: string,
  visual: string | null,
  statuses: EditableStatus[],
  intro: { visual: string | null },
): { statuses: EditableStatus[]; intro: { visual: string | null } } {
  if (tabKey === INTRO_TAB) return { statuses, intro: { visual } };
  return {
    statuses: statuses.map((status) => (status.name === tabKey ? { ...status, visual } : status)),
    intro,
  };
}

// ------------------------------------------------------------ sunucu gövdesi

/** "./resimler/a.png" → "resimler/a.png": adaylarla kayıtlı yol aynı biçimde karşılaşsın. */
export const bareVisual = (path: string): string => path.replace(/^\.\//, '');

/** Sunucuya giden durum listesi: görüntü yoksa alan hiç gönderilmez, bip açıksa yazılmaz. */
export function statusesPayload(statuses: EditableStatus[]): NonNullable<UpdatePomodoroPayload['statuses']> {
  return statuses.map((status) => ({
    name: status.name.trim(),
    minutes: status.minutes,
    ...(status.beep ? {} : { beep: false }),
    ...(status.visual ? { visual: status.visual } : {}),
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
    statuses: statusesPayload(current.statuses ?? []),
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
    statuses: statusesPayload(current?.statuses ?? data.defaults.statuses),
    ...(current?.intro.visual ? { intro: { visual: current.intro.visual } } : {}),
    countdownBeep: current?.countdownBeep ?? data.defaults.countdownBeep,
    ...changes,
  };
}
