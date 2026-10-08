/**
 * 9:16 kadraj hesabı — sunucudaki `core/shorts-plan.js` `computeShortsCrop`
 * aynası. Önizlemenin render'la BİREBİR aynı kutuyu göstermesi için formül
 * tek: burada değişen bir şey orada da değişmeli (çift sayı yuvarlaması
 * dahil, yoksa önizleme 1 piksel kayık olur).
 */

export const SHORTS_TARGET = { width: 1080, height: 1920, aspect: '9:16' };
export const SHORTS_RATIO = SHORTS_TARGET.width / SHORTS_TARGET.height;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DEFAULT_FRAME = { zoom: 1, x: 0.5, y: 0.5 };

export type Frame = { zoom: number; x: number; y: number };
export type Crop = { width: number; height: number; x: number; y: number };

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function evenDown(value: number) {
  return Math.max(0, Math.floor(value / 2) * 2);
}

/** Kadraj oranlarını kaynak videodaki piksel kutusuna çevirir. */
export function computeShortsCrop(
  sourceWidth: number,
  sourceHeight: number,
  frame: Frame,
): Crop {
  const zoom = clamp(frame.zoom, MIN_ZOOM, MAX_ZOOM);
  const sourceRatio = sourceWidth / sourceHeight;
  const baseHeight = sourceRatio > SHORTS_RATIO ? sourceHeight : sourceWidth / SHORTS_RATIO;
  const baseWidth = baseHeight * SHORTS_RATIO;

  const width = evenDown(clamp(baseWidth / zoom, 2, sourceWidth));
  const height = evenDown(clamp(baseHeight / zoom, 2, sourceHeight));
  return {
    width,
    height,
    x: evenDown((sourceWidth - width) * clamp(frame.x, 0, 1)),
    y: evenDown((sourceHeight - height) * clamp(frame.y, 0, 1)),
  };
}

/** `04:21.5` — sunucudaki formatTimecode ile aynı biçim. */
export function formatTimecode(seconds: number) {
  const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const body = `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
  return hours > 0 ? `${hours}:${body}` : body;
}

/**
 * `1:02.5`, `62.5`, `01:02` → saniye. Kullanıcı elle zaman yazabiliyor;
 * anlaşılmayan metin null döner (alan kırmızıya döner, değer değişmez).
 */
export function parseTimecode(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parts = trimmed.split(':');
  if (parts.length > 3 || parts.some((part) => part !== '' && !/^\d*\.?\d*$/.test(part))) return null;
  const numbers = parts.map((part) => (part === '' ? 0 : Number(part)));
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const seconds = numbers.reduce((total, value) => total * 60 + value, 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null;
}
