/**
 * Prompt şablonları — prompts/*.txt okuma, doldurma, prompts.md metni.
 *
 * Tek sorumluluk: stilden AI Studio / video aracı promptlarını üretmek.
 * Stili doğrulamaz (prep/styles.js), dosya yazmaz ve klasör kurmaz (7a).
 *
 * Yer tutucu sözdizimi `{{AD}}` — açılı parantez değil: model `<...>`'yı
 * doldurulacak yer sanıyor (HANDOFF bölüm 4, Faz 2). Doldurma katıdır:
 * tanınmayan ya da bozuk yer tutucu hata, sessizce metinde kalmaz.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText } from '../core/workspace.js';
import { renderStyleBlock } from './styles.js';

/** Repodaki şablon klasörü. */
export const PROMPTS_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));

/** prompts.md'deki sıra. */
export const TEMPLATE_FILES = ['faz1-master.txt', 'faz2-angles.txt', 'faz3-motion.txt'];

const TOKEN = /\{\{([A-Z_]+)\}\}/g;
const FENCE = '```';

export class PromptError extends Error {
  /**
   * @param {string} source
   * @param {string[]} problems
   */
  constructor(source, problems) {
    super(`prompt üretilemedi (${source}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'PromptError';
    this.source = source;
    this.problems = problems;
  }
}

/**
 * Şablonları sırayla okur; BOM ve CRLF temizlenir. Eksik dosyalar tek hatada.
 *
 * @param {{ dir?: string }} [options]
 * @returns {Promise<{ file: string, text: string }[]>}
 */
export async function loadTemplates({ dir = PROMPTS_DIR } = {}) {
  const templates = [];
  const problems = [];
  for (const file of TEMPLATE_FILES) {
    try {
      templates.push({ file, text: normalizeText(await readFile(join(dir, file), 'utf8')) });
    } catch (cause) {
      problems.push(`${file}: okunamadı (${cause.code ?? cause.message})`);
    }
  }
  if (problems.length > 0) throw new PromptError(dir, problems);
  return templates;
}

/**
 * `{{AD}}` yer tutucularını doldurur. Değerler yeniden taranmaz ve `$&` gibi
 * replace kalıpları olduğu gibi yazılır.
 *
 * @param {string} text
 * @param {Record<string, string>} values
 * @param {string} [source] hata mesajı için şablon adı
 * @returns {string}
 */
export function fillTemplate(text, values, source = 'şablon') {
  const problems = [];

  const unknown = new Set();
  const filled = text.replace(TOKEN, (token, key) => {
    if (Object.hasOwn(values, key)) return values[key];
    unknown.add(token);
    return token;
  });
  for (const token of unknown) problems.push(`${source}: tanınmayan yer tutucu ${token}`);

  // Geçerli yer tutucular çıkarıldıktan sonra kalan süslü parantez bozuk yazımdır.
  if (/\{\{|\}\}/.test(text.replace(TOKEN, ''))) {
    problems.push(`${source}: bozuk yer tutucu — biçim {{BÜYÜK_HARF}} olmalı`);
  }

  if (problems.length > 0) throw new PromptError(source, problems);
  return filled;
}

/**
 * prompts.md metni: başlık + doldurulmuş şablonlar.
 *
 * @param {{ videoName: string, style: object, templates: { file: string, text: string }[] }} input
 *   style doğrulanmış olmalı (loadStyle)
 * @returns {string} LF, sonda tek satır sonu
 */
export function buildPromptsMd({ videoName, style, templates }) {
  const values = {
    STYLE_NAME: style.name,
    STYLE_BLOCK: renderStyleBlock(style),
    MOTION_HINTS: style.motionHints.map((hint) => hint.trim().replace(/\.+$/, '')).join(', '),
  };
  const problems = [];

  for (const [key, value] of Object.entries(values)) {
    if (value.includes(FENCE)) problems.push(`${key}: "${FENCE}" içeremez — kod bloğunu kapatır`);
  }

  const sections = [];
  for (const { file, text } of templates) {
    try {
      sections.push(fillTemplate(text, values, file).trimEnd());
    } catch (error) {
      if (!(error instanceof PromptError)) throw error;
      problems.push(...error.problems);
    }
  }
  if (problems.length > 0) throw new PromptError('prompts.md', problems);

  const header = [
    `# ${videoName} — Üretim promptları`,
    '',
    `Stil: \`${style.name}\` · stil bloğu ayrıca \`STYLE_BLOCK.txt\` dosyasında.`,
    'Kod bloklarındaki metin olduğu gibi kopyalanır; blok dışındaki notlar prompta girmez.',
  ].join('\n');
  const md = [header, ...sections].join('\n\n') + '\n';

  // Kopyalanan metin yalnızca kod blokları — açılı parantez yasağı orada geçerli.
  const { blocks, unclosed } = codeBlocks(md);
  if (unclosed) problems.push('kapanmamış kod bloğu');
  blocks.forEach((block, i) => {
    if (/[<>]/.test(block)) problems.push(`kod bloğu ${i + 1}: "<" ya da ">" içeriyor (bölüm 4, Faz 2)`);
  });
  if (problems.length > 0) throw new PromptError('prompts.md', problems);

  return md;
}

/**
 * Markdown'daki ``` bloklarının içerikleri.
 *
 * @param {string} md
 * @returns {{ blocks: string[], unclosed: boolean }}
 */
export function codeBlocks(md) {
  const blocks = [];
  let current = null;
  for (const line of md.split('\n')) {
    if (line.startsWith(FENCE)) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
    } else if (current !== null) {
      current.push(line);
    }
  }
  return { blocks, unclosed: current !== null };
}
