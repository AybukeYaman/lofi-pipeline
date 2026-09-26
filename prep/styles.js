/**
 * Stil kütüphanesi — styles/<ad>.json okuma, doğrulama, stil bloğu metni.
 *
 * Tek sorumluluk: bir stilin geçerli olduğunu garanti etmek ve AI Studio'ya
 * verilecek metne çevirmek. Proje klasörü kurmaz (7a), prompt doldurmaz (7c),
 * model çağırmaz (7d).
 *
 * Şema alanlara bölünmüş — 7d'deki Gemini responseSchema'sı aynı alanlardan
 * (STYLE_FIELDS) kurulacak. Hatalar config.js'teki gibi TEK seferde raporlanır.
 */

import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAGE_EXTENSIONS, listFiles } from '../core/files.js';
import { readJsonFile } from '../core/workspace.js';
import { findAmbient } from './ambients.js';

/** Repodaki stil klasörü. */
export const STYLES_DIR = fileURLToPath(new URL('../styles/', import.meta.url));

/** Stil adı = dosya adı: küçük harf kebab-case ("neo-tokyo"). */
/** Stil adı: küçük harf kebab-case (add-style, panel ve web aynı kuralı kullanır). */
export const STYLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Projeye özel, referans görsellerden üretilen stil; styles/ altında dosyası yok. */
export const CUSTOM_STYLE_NAME = 'custom-generated';

/**
 * styleBlock alanları — metin çıktısındaki sıra ve başlıklar.
 * `palette` renk listesi, diğerleri düz metin.
 */
export const STYLE_FIELDS = [
  { key: 'medium', label: 'Medium / technique' },
  { key: 'lines', label: 'Line quality' },
  { key: 'palette', label: 'Color palette' },
  { key: 'light', label: 'Lighting' },
  { key: 'texture', label: 'Texture / grain' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'shading', label: 'Shading' },
];

/** `music`: opsiyonel albüm kimliği bloğu — prep/album-prompt.js okur ve doğrular. */
const ROOT_KEYS = ['name', 'styleBlock', 'suggestedAmbient', 'motionHints', 'music'];

/**
 * Loop'ta kapanmayan yönlü hareketler (HANDOFF bölüm 4, Faz 3). Uyarıdır:
 * kelime bağlam dışı geçebilir, ama 7d'nin ürettiği ipuçlarında yakalanmalı.
 */
const DIRECTIONAL_MOTION = /\b(pan|pans|panning|zoom|zooms|zooming|dolly|camera (?:moves|moving|move)|walks?|walking|runs?|running)\b/i;

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
 * Stilin tüm referans görsellerini bulur (styles/refs/<ad>.*, styles/refs/<ad>-*.*, styles/refs/<ad>_*.*).
 *
 * @param {string} name doğrulanmış stil adı
 * @param {{ dir?: string }} [options] stil klasörü; görseller `<dir>/refs/`
 * @returns {Promise<{ paths: string[], warnings: string[] }>}
 */
export async function findStyleRefs(name, { dir = STYLES_DIR } = {}) {
  let paths;
  try {
    paths = await listFiles(join(dir, 'refs'), IMAGE_EXTENSIONS);
  } catch (cause) {
    if (cause.code === 'ENOENT') return { paths: [], warnings: [] };
    throw cause;
  }

  const exactMatches = paths.filter((path) => basename(path, extname(path)) === name);
  exactMatches.sort((a, b) => {
    const extA = extname(a).toLowerCase();
    const extB = extname(b).toLowerCase();
    return IMAGE_EXTENSIONS.indexOf(extA) - IMAGE_EXTENSIONS.indexOf(extB);
  });

  const secondaryMatches = paths.filter((path) => {
    const base = basename(path, extname(path));
    return base.startsWith(`${name}-`) || base.startsWith(`${name}_`);
  });
  secondaryMatches.sort((a, b) => {
    const baseA = basename(a, extname(a));
    const baseB = basename(b, extname(b));
    return baseA.localeCompare(baseB, undefined, { numeric: true });
  });

  const warnings = [];
  if (exactMatches.length > 1) {
    warnings.push(
      `"${name}" için birden fazla referans görseli bulundu (${exactMatches.map((p) => basename(p)).join(', ')}), ` +
      `"${basename(exactMatches[0])}" kullanılacak`,
    );
  }

  return { paths: [...exactMatches, ...secondaryMatches], warnings };
}

/**
 * Stilin birincil referans görseli. Klasör ya da görsel yoksa `path: null`.
 *
 * @param {string} name doğrulanmış stil adı
 * @param {{ dir?: string }} [options] stil klasörü; görseller `<dir>/refs/`
 * @returns {Promise<{ path: string | null, warnings: string[] }>}
 */
export async function findStyleRef(name, { dir = STYLES_DIR } = {}) {
  const { paths, warnings } = await findStyleRefs(name, { dir });
  return { path: paths[0] ?? null, warnings };
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
  if (name === CUSTOM_STYLE_NAME) {
    return {
      style: { name: CUSTOM_STYLE_NAME, suggestedAmbient: 'none' },
      path: join(dir, `${CUSTOM_STYLE_NAME}.json`),
      warnings: [],
    };
  }

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
 * Saf doğrulama — dosyaya dokunmaz. 7d modelin çıktısını kaydetmeden önce
 * aynı fonksiyondan geçirecek.
 *
 * @param {unknown} json
 * @param {{ expectedName?: string, ambients?: { name: string, path: string }[] }} [context]
 * @returns {{ problems: string[], warnings: string[] }}
 */
export function validateStyle(json, { expectedName, ambients } = {}) {
  const problems = [];
  const warnings = [];

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { problems: ['kök bir nesne olmalı: { "name": ..., "styleBlock": {...}, ... }'], warnings };
  }

  unknownKeys(json, ROOT_KEYS, '', warnings);

  // --- name
  if (requireText(json.name, 'name', problems)) {
    if (!STYLE_NAME_PATTERN.test(json.name)) {
      problems.push(`name: küçük harf kebab-case olmalı (verilen: ${JSON.stringify(json.name)})`);
    } else if (expectedName !== undefined && json.name !== expectedName) {
      problems.push(`name: dosya adıyla aynı olmalı ("${expectedName}", verilen: "${json.name}")`);
    }
  }

  // --- styleBlock
  const block = json.styleBlock;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    problems.push('styleBlock: nesne olmalı' + (block === undefined ? ' (eksik)' : ''));
  } else {
    unknownKeys(block, STYLE_FIELDS.map((f) => f.key), 'styleBlock.', warnings);
    for (const { key } of STYLE_FIELDS) {
      if (key === 'palette') validatePalette(block.palette, problems);
      else requireText(block[key], `styleBlock.${key}`, problems);
    }
  }

  // --- suggestedAmbient
  if (requireText(json.suggestedAmbient, 'suggestedAmbient', problems) && ambients) {
    if (!findAmbient(ambients, json.suggestedAmbient)) {
      warnings.push(
        `suggestedAmbient: "${json.suggestedAmbient}" ambient klasöründe yok — mevcut: ` +
        (ambients.map((a) => a.name).join(', ') || '(yok)'),
      );
    }
  }

  // --- motionHints
  if (!Array.isArray(json.motionHints) || json.motionHints.length === 0) {
    problems.push('motionHints: boş olmayan bir dizi olmalı');
  } else {
    json.motionHints.forEach((hint, i) => {
      if (requireText(hint, `motionHints[${i}]`, problems) && DIRECTIONAL_MOTION.test(hint)) {
        warnings.push(`motionHints[${i}]: yönlü hareket loop'ta kapanmaz (bölüm 4, Faz 3): "${hint}"`);
      }
    });
  }

  // --- promptu bozan karakterler (her metin alanında)
  for (const [where, text] of strings(json)) {
    if (/[<>]/.test(text)) {
      problems.push(`${where}: "<" ya da ">" içeremez — model açılı parantezi doldurulacak yer sanıyor (bölüm 4, Faz 2)`);
    }
    if (/\{\{|\}\}/.test(text)) {
      problems.push(`${where}: "{{" ya da "}}" içeremez — prompt şablonlarının yer tutucu sözdizimi`);
    }
  }

  return { problems, warnings };
}

/**
 * styleBlock → AI Studio'ya yapıştırılacak düz metin. Markdown yok: metin
 * promptun içine gömülüyor, `**` modele gürültü olur.
 *
 * @param {{ styleBlock: object }} style doğrulanmış stil
 * @returns {string} sonunda satır sonu yok
 */
export function renderStyleBlock(style) {
  if (!style || !style.styleBlock) return '';
  return STYLE_FIELDS.map(({ key, label }) => {
    if (key !== 'palette') return `${label}: ${style.styleBlock[key]}`;
    const colors = style.styleBlock.palette.map((c) => `- ${c.hex.toUpperCase()} ${c.role}`);
    return [`${label}:`, ...colors].join('\n');
  }).join('\n');
}

// ---------------------------------------------------------------- yardımcılar

function validatePalette(palette, problems) {
  if (!Array.isArray(palette) || palette.length === 0) {
    problems.push('styleBlock.palette: boş olmayan bir dizi olmalı: [{ "hex": "#RRGGBB", "role": "..." }]');
    return;
  }
  palette.forEach((color, i) => {
    const at = `styleBlock.palette[${i}]`;
    if (color === null || typeof color !== 'object' || Array.isArray(color)) {
      problems.push(`${at}: { "hex": "#RRGGBB", "role": "..." } biçiminde olmalı`);
      return;
    }
    if (typeof color.hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(color.hex)) {
      problems.push(`${at}.hex: #RRGGBB biçiminde olmalı (verilen: ${JSON.stringify(color.hex)})`);
    }
    requireText(color.role, `${at}.role`, problems);
  });
}

/** @returns {boolean} geçerliyse true */
function requireText(value, key, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: boş olmayan bir metin olmalı${value === undefined ? ' (eksik)' : ''}`);
    return false;
  }
  return true;
}

function unknownKeys(object, known, prefix, warnings) {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      warnings.push(`Bilinmeyen anahtar yok sayıldı: "${prefix}${key}" (yazım hatası olabilir)`);
    }
  }
}

/**
 * Nesnedeki bütün metinler, konumlarıyla.
 * @returns {Generator<[string, string]>}
 */
function* strings(value, where = '') {
  if (typeof value === 'string') {
    yield [where || '(kök)', value];
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) yield* strings(value[i], `${where}[${i}]`);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) yield* strings(child, where ? `${where}.${key}` : key);
  }
}
