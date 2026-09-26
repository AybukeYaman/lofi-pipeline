/**
 * Prompt şablonları — prompts/*.txt okuma, prompts.md metni.
 *
 * Tek sorumluluk: kamera açısı (Faz 2) promptlarını projeye hazırlamak.
 * Master görseli ve klip elle üretildiği için onların promptu yok. Dosya
 * yazmaz ve klasör kurmaz (7a).
 *
 * Kopyalanan metinde açılı parantez yasak: model `<...>`'yı doldurulacak
 * yer sanıyor (HANDOFF bölüm 4, Faz 2).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText } from '../core/workspace.js';

/** Repodaki şablon klasörü. */
export const PROMPTS_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));

/** prompts.md'deki sıra. */
export const TEMPLATE_FILES = ['faz2-angles.txt'];

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
 * prompts.md metni: başlık + şablonlar.
 *
 * @param {{ videoName: string, templates: { file: string, text: string }[] }} input
 * @returns {string} LF, sonda tek satır sonu
 */
export function buildPromptsMd({ videoName, templates }) {
  const header = [
    `# ${videoName} — Kamera açısı promptları`,
    '',
    'Kod bloklarındaki metin olduğu gibi kopyalanır; blok dışındaki notlar prompta girmez.',
  ].join('\n');
  const md = [header, ...templates.map(({ text }) => text.trimEnd())].join('\n\n') + '\n';

  const problems = [];
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

/**
 * Faz 2 (kamera açıları) şablon metni.
 *
 * @param {{ templates?: { file: string, text: string }[] }} [input]
 * @returns {Promise<string>} şablon yoksa boş metin
 */
export async function getAnglePrompts(input = {}) {
  const templates = input.templates ?? await loadTemplates();
  return templates.find((item) => item.file === 'faz2-angles.txt')?.text.trimEnd() ?? '';
}
