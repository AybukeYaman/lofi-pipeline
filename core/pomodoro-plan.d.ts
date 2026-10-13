/** Web arayüzünün okuduğu kısım: hazır düzenler ve varsayılanlar (tek kaynak core/pomodoro-plan.js). */
export const POMODORO_PRESETS: ReadonlyArray<{
  id: string;
  statuses: ReadonlyArray<{ name: string; minutes: number; beep: boolean; visual: string | null }>;
}>;
export const POMODORO_DEFAULTS: { rounds: number };
