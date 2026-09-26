import type { StyleMusic } from './types';

/** Müzik profili alanları — sunucudaki prep/styles.js MUSIC_FIELDS ile aynı sıra. */
export const MUSIC_FIELDS: Array<{ key: keyof StyleMusic; label: string; hint: string }> = [
  { key: 'genre', label: 'Genre', hint: 'lofi hip hop, chillhop' },
  { key: 'production', label: 'Production', hint: 'warm tape saturation, vinyl crackle' },
  { key: 'instruments', label: 'Instruments', hint: 'dusty Rhodes piano, upright bass' },
  { key: 'aesthetic', label: 'Aesthetic', hint: 'late night city apartment, rain on glass' },
  { key: 'exclude', label: 'Exclude', hint: 'vocals, EDM drops' },
];

/** Alan değeri → düz liste (metin ya da metin dizisi olabilir). */
export function musicItems(value: string | string[] | undefined): string[] {
  return ([] as string[]).concat(value ?? []).map((item) => item.trim()).filter(Boolean);
}

/** Kısa özet: hariç tutulanlar dışındaki alanlar; profil boşsa null. */
export function musicSummary(music: StyleMusic | null | undefined): string | null {
  if (!music) return null;
  const parts = MUSIC_FIELDS.filter((field) => field.key !== 'exclude').flatMap((field) => musicItems(music[field.key]));
  return parts.length > 0 ? parts.join(', ') : null;
}
