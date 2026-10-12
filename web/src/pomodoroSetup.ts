/**
 * Pomodoro düzeni seçiminin saf yardımcıları — `PomodoroSetup` (proje formu ve
 * ayar kutusu aynı bileşeni kullanır) ve testleri buradan okur.
 *
 * Kullanıcı "2 saatlik video" diye düşünüyor, sistem tur sayısıyla çalışıyor:
 * burada süre ↔ tur çevirisi tek yerde durur, hiçbir ekran kendi hesabını yapmaz.
 * Gerçek timeline hesabı sunucuda (core/pomodoro-plan.js `buildTimeline`); buradaki
 * yalnızca seçim düğmelerinin etiketi için basit çarpma.
 *
 * Her Pomodoro videosu 2 dakikalık bir GET READY ile başlar (`INTRO_MINUTES`, sunucudaki
 * `INTRO_SECONDS` aynası); "video süresi" düğmeleri yalnızca çalışma+mola kısmını gösterir.
 */

import type { ProjectPomodoro, UpdatePomodoroPayload } from './types';

/** Tur düğmeleri: her biri toplam süre etiketiyle gösterilir. */
export const ROUND_CHOICES = [1, 2, 3, 4, 6];

/** Videonun başındaki GET READY oturumu (dk) — core/pomodoro-plan.js `INTRO_SECONDS` aynası. */
export const INTRO_MINUTES = 2;

/** Bir turun (çalışma + mola) dakikası. */
export function cycleMinutes(workMinutes: number, breakMinutes: number): number {
  return workMinutes + breakMinutes;
}

/** Yalnızca çalışma + mola turlarının süresi (dakika) — düğmelerde "2 saat" diye görünen. */
export function studyMinutes(workMinutes: number, breakMinutes: number, rounds: number): number {
  return cycleMinutes(workMinutes, breakMinutes) * rounds;
}

/** Toplam video süresi (dakika): GET READY dahil. Müziğin doldurması gereken süre bu. */
export function totalMinutes(workMinutes: number, breakMinutes: number, rounds: number): number {
  return INTRO_MINUTES + studyMinutes(workMinutes, breakMinutes, rounds);
}

/** 40 → "40 dk", 60 → "1 saat", 80 → "1 saat 20 dk", 240 → "4 saat". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} dk`;
  return rest === 0 ? `${hours} saat` : `${hours} saat ${rest} dk`;
}

/**
 * Düzen değişince çalışma süresini olabildiğince korur: 2 saat 50/10 → 30/10'da 3 tur (yine 2 saat).
 * `previousStudyMinutes` GET READY HARİÇ çalışma+mola süresidir (`studyMinutes`).
 */
export function roundsKeepingTotal(
  previousStudyMinutes: number,
  workMinutes: number,
  breakMinutes: number,
): number {
  const cycle = cycleMinutes(workMinutes, breakMinutes);
  return Math.min(24, Math.max(1, Math.round(previousStudyMinutes / cycle)));
}

/** Tur düğmeleri: sabit liste + elle yazılmış (eski proje) bir değer varsa o da görünür. */
export function roundChoicesFor(current: number): number[] {
  return ROUND_CHOICES.includes(current)
    ? ROUND_CHOICES
    : [...ROUND_CHOICES, current].sort((a, b) => a - b);
}

/** "50/10 · 2 saat · 2 tur" — başlık çipi ve özet satırları aynı cümleyi kullanır. */
export function pomodoroSummary(
  workMinutes: number,
  breakMinutes: number,
  rounds: number,
): string {
  return `${workMinutes}/${breakMinutes} · ${durationLabel(totalMinutes(workMinutes, breakMinutes, rounds))} · ${rounds} tur`;
}

/**
 * Sunucuya gidecek tam gövde: ekranın bütün alanları her seferinde birlikte gider
 * (PUT eksik alanı varsayılana çevirir). Ayar kutusu da mola görüntüsü kutusu da
 * bunu kullanır — biri yazarken öbürünün alanı kaybolmasın.
 */
export function pomodoroPayload(
  data: ProjectPomodoro,
  changes: Partial<UpdatePomodoroPayload> = {},
): UpdatePomodoroPayload {
  const current = data.settings;
  return {
    enabled: true,
    workMinutes: current?.workMinutes ?? data.defaults.workMinutes,
    breakMinutes: current?.breakMinutes ?? data.defaults.breakMinutes,
    rounds: current?.rounds ?? data.defaults.rounds,
    countdownBeep: current?.countdownBeep ?? data.defaults.countdownBeep,
    ...(current?.breakClip ? { breakClip: current.breakClip } : {}),
    // Düzen değişince eski kırpma onayı taşınmaz: yeni timeline'da ne kadar
    // fazla olduğu farklı, kullanıcı yeniden görüp onaylasın.
    trimExcess: changes.trimExcess ?? (changes.rounds === undefined && changes.workMinutes === undefined
      ? current?.trimExcess ?? false
      : false),
    ...changes,
  };
}

/**
 * Müziğe sığan en çok tur: GET READY düşüldükten sonra tam turlar. En az 1.
 * "Süreyi müziğe uydur" düğmesi bunu kullanır; geriye kalan küçük fazlalık
 * kırpma onayıyla (`trimExcess`) kesilir, eksik bırakılmaz.
 */
export function roundsFittingMusic(
  musicSeconds: number,
  workMinutes: number,
  breakMinutes: number,
): number {
  const cycleSeconds = cycleMinutes(workMinutes, breakMinutes) * 60;
  const available = musicSeconds - INTRO_MINUTES * 60;
  return Math.min(24, Math.max(1, Math.floor(available / cycleSeconds)));
}
