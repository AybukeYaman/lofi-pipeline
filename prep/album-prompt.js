/**
 * Albüm prompt motoru (11f-2) — saf fonksiyonlar.
 *
 * DNA / varyant ayrımı:
 *   DNA     = albüm kimliği (tür, prodüksiyon, çekirdek enstrümanlar, estetik).
 *             Her parçada BİREBİR AYNI; stil dizesinin başında durur çünkü Suno
 *             erken token'lara daha çok ağırlık veriyor.
 *   varyant = parçaya özel atmosfer + album-arc.js'ten gelen enerji niteleyicileri.
 *
 * Müzik kimliği stil dosyasının `music` bloğundan okunur (styles/<ad>.json):
 *   "music": { "genre", "production", "instruments", "aesthetic", "exclude" }
 * Her alan metin ya da metin dizisi olabilir.
 */

import { AlbumPromptError } from './album-errors.js';
import { cleanStyleString } from './style-cleaner.js';
import { buildExcludePrompt } from './style-exclude.js';

/** Suno karakter sınırları (V4.5+ / V5 / V5.5). Aşılırsa Suno sessizce keser ya da API 400 döner. */
export const SUNO_LIMITS = Object.freeze({ style: 1000, negativeTags: 200, title: 80 });

/** DNA alanları, stil dizesindeki sırayla. */
export const DNA_FIELDS = Object.freeze(['genre', 'production', 'instruments', 'aesthetic']);

const INSTRUMENTAL_HEAD = '[Instrumental] ';
const INSTRUMENTAL_TAIL = '. No vocals, no lyrics. [No Vocals]';

/** Metin ya da metin dizisini boş olmayan parçalara açar. */
function textParts(value) {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
}

/** @returns {object} stilin music bloğu */
function musicBlock(style) {
  const music = style?.music;
  if (music === null || typeof music !== 'object' || Array.isArray(music)) {
    throw new AlbumPromptError(
      `Stilde "music" bloğu yok${style?.name ? ` (${style.name})` : ''}. ` +
      `Albüm üretimi için styles/<ad>.json içine { "music": { ${DNA_FIELDS.map((f) => `"${f}"`).join(', ')}, "exclude" } } ekleyin.`,
    );
  }
  return music;
}

/**
 * Albüm DNA'sı: albüm boyunca sabit kalan stil kimliği.
 *
 * @param {object} style stil dosyası (music bloğu zorunlu)
 * @returns {string}
 * @throws {AlbumPromptError} music bloğu yoksa ya da DNA alanlarının hepsi boşsa
 */
export function buildAlbumDna(style) {
  const music = musicBlock(style);
  const dna = cleanStyleString(DNA_FIELDS.flatMap((field) => textParts(music[field])).join(', '));
  if (dna === '') {
    throw new AlbumPromptError(`Stilin music bloğunda DNA alanlarının hepsi boş (${DNA_FIELDS.join(', ')}).`);
  }
  return dna;
}

/**
 * Parça stil dizesi. Sıra sabit: DNA önce, parça farkı arkadan.
 * Instrumental kilidi iki uçta birden — tek başına güvenilir değil.
 *
 * @param {{ dna: string, atmosphere: string, energyMods: { rhythm: string, tempo: string, density: string } }} input
 * @returns {string}
 * @throws {AlbumPromptError}
 */
export function buildTrackStyle({ dna, atmosphere, energyMods } = {}) {
  const parts = { dna, atmosphere, rhythm: energyMods?.rhythm, tempo: energyMods?.tempo, density: energyMods?.density };
  const missing = Object.entries(parts).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
  if (missing.length > 0) {
    throw new AlbumPromptError(`Parça stili için eksik alan: ${missing.join(', ')}`);
  }
  const body = Object.values(parts).map((v) => v.trim()).join(', ');
  return `${INSTRUMENTAL_HEAD}${body}${INSTRUMENTAL_TAIL}`;
}

/**
 * Negatif etiketler (Suno negative_tags / Exclude).
 *
 * @param {object} style stil dosyası (music bloğu zorunlu; exclude yoksa boş döner)
 * @returns {string}
 * @throws {AlbumPromptError} SUNO_LIMITS.negativeTags aşılırsa
 */
export function buildNegativeTags(style) {
  const tags = buildExcludePrompt(musicBlock(style));
  assertLength('negativeTags', tags);
  return tags;
}

/**
 * İstek gönderilmeden önce yerel sınır doğrulaması.
 *
 * @param {{ style: string, negativeTags?: string, title: string }} fields
 * @throws {AlbumPromptError} ilk aşılan alan için
 */
export function assertSunoLimits({ style, negativeTags = '', title } = {}) {
  assertLength('style', style);
  assertLength('negativeTags', negativeTags);
  assertLength('title', title);
}

function assertLength(field, value) {
  if (typeof value !== 'string') {
    throw new AlbumPromptError(`${field} metin olmalı, verilen: ${typeof value}`, { field });
  }
  const limit = SUNO_LIMITS[field];
  if (value.length > limit) {
    throw new AlbumPromptError(
      `${field} Suno sınırını aşıyor: ${value.length}/${limit} karakter. İstek gönderilmedi.`,
      { field, limit, length: value.length },
    );
  }
}
