/**
 * Stil kütüphanesi — styles/<ad>.json okuma ve doğrulama.
 *
 * Stil bir müzik profilidir: ad + `music` bloğu (albüm prompt'ları,
 * prep/album-prompt.js) + isteğe bağlı önerilen ambient. Görseller elle
 * üretildiği için görsel tanım (style block, referans görseli) yok; eski
 * dosyalardaki bu alanlar diskte kalır, okunmaz. Hatalar config.js'teki
 * gibi TEK seferde raporlanır.
 */

import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFiles } from '../core/files.js';
import { readJsonFile } from '../core/workspace.js';
import { findAmbient } from './ambients.js';

/** Repodaki stil klasörü. */
export const STYLES_DIR = fileURLToPath(new URL('../styles/', import.meta.url));

/** Stil adı = dosya adı: küçük harf kebab-case ("neo-tokyo"). Panel, CLI ve web aynı kuralı kullanır. */
export const STYLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Müzik profili alanları — web formu ve albüm prompt'ları (album-prompt.js
 * DNA_FIELDS + exclude) aynı adları kullanır. Metin ya da metin dizisi.
 */
export const MUSIC_FIELDS = ['genre', 'production', 'instruments', 'aesthetic', 'exclude'];

const ROOT_KEYS = ['name', 'music', 'suggestedAmbient'];
/** Eski görsel stil alanları: dosyada kalabilir, uyarısız yok sayılır. */
const LEGACY_KEYS = ['styleBlock', 'motionHints'];

export class StyleError extends Error {
  /**
   * @param {string} source stil adı ya da dosya yolu
   * @param {string[]} problems
   */
  constructor(source, problems) {
    super(`stil geçersiz (${source}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'StyleError';
    this.source = source;
    this.problems = problems;
  }
}

/**
 * Stil klasöründeki stil adları, doğal sırada.
 *
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function listStyles({ dir = STYLES_DIR } = {}) {
  const paths = await listFiles(dir, ['.json']);
  return paths.map((path) => basename(path, '.json'));
}

/**
 * Stili okur ve doğrular.
 *
 * @param {string} name
 * @param {{ dir?: string, ambients?: { name: string, path: string }[] }} [options]
 *   ambients verilirse suggestedAmbient kütüphanede aranır (yoksa uyarı)
 * @returns {Promise<{ style: object, path: string, warnings: string[] }>}
 */
export async function loadStyle(name, { dir = STYLES_DIR, ambients } = {}) {
  if (typeof name !== 'string' || !STYLE_NAME_PATTERN.test(name)) {
    throw new StyleError(String(name), [`stil adı küçük harf kebab-case olmalı (ör. "neo-tokyo"), verilen: ${JSON.stringify(name)}`]);
  }

  const path = join(dir, `${name}.json`);
  let json;
  try {
    json = await readJsonFile(path);
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      const available = await listStyles({ dir }).catch(() => []);
      throw new StyleError(name, [
        `bilinmeyen stil — mevcut: ${available.length > 0 ? available.join(', ') : '(yok)'}`,
      ]);
    }
    throw new StyleError(path, [
      cause instanceof SyntaxError
        ? `JSON ayrıştırılamadı: ${cause.message}`
        : `dosya okunamadı: ${cause.code ?? cause.message}`,
    ]);
  }

  const { problems, warnings } = validateStyle(json, { expectedName: name, ambients });
  if (problems.length > 0) throw new StyleError(path, problems);
  return { style: json, path, warnings };
}

/**
 * Saf doğrulama — dosyaya dokunmaz.
 *
 * @param {unknown} json
 * @param {{ expectedName?: string, ambients?: { name: string, path: string }[] }} [context]
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function validateStyle(json, { expectedName, ambients } = {}) {
  const problems = [];
  const warnings = [];

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { problems: ['kök bir nesne olmalı: { "name": ..., "music": {...} }'], warnings };
  }

  for (const key of Object.keys(json)) {
    if (!ROOT_KEYS.includes(key) && !LEGACY_KEYS.includes(key)) {
      warnings.push(`Bilinmeyen anahtar yok sayıldı: "${key}" (yazım hatası olabilir)`);
    }
  }

  // --- name
  if (requireText(json.name, 'name', problems)) {
    if (!STYLE_NAME_PATTERN.test(json.name)) {
      problems.push(`name: küçük harf kebab-case olmalı (verilen: ${JSON.stringify(json.name)})`);
    } else if (expectedName !== undefined && json.name !== expectedName) {
      problems.push(`name: dosya adıyla aynı olmalı ("${expectedName}", verilen: "${json.name}")`);
    }
  }

  // --- music (isteğe bağlı; boşken albüm üretimi album-prompt.js'te durur)
  if (json.music !== undefined) {
    const music = json.music;
    if (music === null || typeof music !== 'object' || Array.isArray(music)) {
      problems.push('music: nesne olmalı: { "genre", "production", "instruments", "aesthetic", "exclude" }');
    } else {
      for (const key of Object.keys(music)) {
        if (!MUSIC_FIELDS.includes(key)) warnings.push(`Bilinmeyen anahtar yok sayıldı: "music.${key}" (yazım hatası olabilir)`);
      }
      for (const key of MUSIC_FIELDS) {
        const value = music[key];
        if (value === undefined) continue;
        const ok = typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
        if (!ok) problems.push(`music.${key}: metin ya da metin dizisi olmalı`);
      }
    }
  }

  // --- suggestedAmbient (isteğe bağlı)
  if (json.suggestedAmbient !== undefined && requireText(json.suggestedAmbient, 'suggestedAmbient', problems) && ambients) {
    if (!findAmbient(ambients, json.suggestedAmbient)) {
      warnings.push(
        `suggestedAmbient: "${json.suggestedAmbient}" ambient klasöründe yok — mevcut: ` +
        (ambients.map((a) => a.name).join(', ') || '(yok)'),
      );
    }
  }

  return { problems, warnings };
}

/**
 * Stilin müzik profili dolu mu (en az bir alan boş olmayan metin içeriyor)?
 *
 * @param {object} style doğrulanmış stil
 * @returns {boolean}
 */
export function hasMusicProfile(style) {
  const music = style?.music;
  if (music === null || typeof music !== 'object') return false;
  return MUSIC_FIELDS.some((key) => [].concat(music[key] ?? []).some((item) => typeof item === 'string' && item.trim() !== ''));
}

/**
 * Müzik planlayıcısına verilecek stil metni: hariç tutulanlar dışındaki profil
 * alanları. Profil boşsa undefined (planlayıcı varsayılan lofi tanımını kullanır).
 *
 * @param {object|null|undefined} style doğrulanmış stil
 * @returns {string|undefined}
 */
export function musicStyleText(style) {
  if (!hasMusicProfile(style)) return undefined;
  const parts = MUSIC_FIELDS
    .filter((key) => key !== 'exclude')
    .flatMap((key) => [].concat(style.music[key] ?? []))
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

// ---------------------------------------------------------------- yardımcılar

/** @returns {boolean} geçerliyse true */
function requireText(value, key, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: boş olmayan bir metin olmalı${value === undefined ? ' (eksik)' : ''}`);
    return false;
  }
  return true;
}
