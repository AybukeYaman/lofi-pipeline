/**
 * Pomodoro düzeni seçiminin saf yardımcıları — `PomodoroSetup` (proje formu ve
 * ayar kutusu aynı bileşeni kullanır) ve testleri buradan okur.
 *
 * Kullanıcı "2 saatlik video" diye düşünüyor, sistem tur sayısıyla çalışıyor:
 * burada süre ↔ tur çevirisi tek yerde durur, hiçbir ekran kendi hesabını yapmaz.
 * Gerçek timeline hesabı sunucuda (core/pomodoro-plan.js `buildTimeline`); buradaki
 * yalnızca seçim düğmelerinin etiketi için basit çarpma.
 */

import type { ProjectPomodoro, UpdatePomodoroPayload } from './types';

/** Tur düğmeleri: her biri toplam süre etiketiyle gösterilir. */
export const ROUND_CHOICES = [1, 2, 3, 4, 6];

/** Bir turun (çalışma + mola) dakikası. */
export function cycleMinutes(workMinutes: number, breakMinutes: number): number {
  return workMinutes + breakMinutes;
}

/** Toplam video süresi (dakika). */
export function totalMinutes(workMinutes: number, breakMinutes: number, rounds: number): number {
  return cycleMinutes(workMinutes, breakMinutes) * rounds;
}

/** 40 → "40 dk", 60 → "1 saat", 80 → "1 saat 20 dk", 240 → "4 saat". */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} dk`;
  return rest === 0 ? `${hours} saat` : `${hours} saat ${rest} dk`;
}

/** Düzen değişince video süresini olabildiğince korur: 2 saat 50/10 → 30/10'da 3 tur (yine 2 saat). */
export function roundsKeepingTotal(
  previousTotalMinutes: number,
  workMinutes: number,
  breakMinutes: number,
): number {
  const cycle = cycleMinutes(workMinutes, breakMinutes);
  return Math.min(24, Math.max(1, Math.round(previousTotalMinutes / cycle)));
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
    workStartSound: current?.workStartSound ?? data.defaults.workStartSound,
    breakStartSound: current?.breakStartSound ?? data.defaults.breakStartSound,
    ...(current?.breakClip ? { breakClip: current.breakClip } : {}),
    // Düzen değişince eski kırpma onayı taşınmaz: yeni timeline'da ne kadar
    // fazla olduğu farklı, kullanıcı yeniden görüp onaylasın.
    trimExcess: changes.trimExcess ?? (changes.rounds === undefined && changes.workMinutes === undefined
      ? current?.trimExcess ?? false
      : false),
    ...changes,
  };
}
