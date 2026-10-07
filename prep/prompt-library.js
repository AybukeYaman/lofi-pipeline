/**
 * Prompt kütüphanesi — kullanıcının kendi promptlarının kalıcı deposu.
 *
 * Tek sorumluluk: `prompts/library/*.json` dosyalarını okumak, doğrulamak ve
 * yazmak. Kopyalama, arayüz ve HTTP bu modülün dışında (server/prompt-api.js,
 * web/src/pages/PromptLibrary.tsx).
 *
 * Neden ayrı bir depo: `prompts/faz2-angles.txt` uygulamayla gelen sabit
 * şablon, `TEMPLATE_FILES`'a elle yazılıyor ve yalnızca kamera açısı adımında
 * kullanılıyor. Kullanıcının promptları ise sayı ve içerik olarak serbest ve
 * her an kopyalanabilir olmalı — şablon listesine sıkıştırılamaz.
 *
 * Biçim `prep/styles.js` ile aynı kalıpta: dosya adı = slug, içerik tek nesne.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText, readJsonFile, writeTextFile } from '../core/workspace.js';

/** Kullanıcı promptlarının klasörü. */
export const PROMPT_LIBRARY_DIR = fileURLToPath(new URL('../prompts/library/', import.meta.url));

/** Dosya adı: küçük harf kebab-case (prep/styles.js STYLE_NAME_PATTERN ile aynı kural). */
export const PROMPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Başlık ve metin sınırları — kaza ile yapıştırılan koca dosya diske yazılmasın. */
export const PROMPT_LIMITS = { title: 120, text: 20000, note: 500 };

/**
 * Promptun hangi aşamada işe yaradığı. Arayüz buna göre süzüyor: `music`
 * etiketli promptlar Müzik adımında da görünür. `general` her yerde.
 */
export const PROMPT_TAGS = ['general', 'image', 'music', 'video'];

export class PromptLibraryError extends Error {
  /**
   * @param {string} source
   * @param {string[]} problems
   */
  constructor(source, problems) {
    super(`prompt geçersiz (${source}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'PromptLibraryError';
    this.source = source;
    this.problems = problems;
  }
}

/**
 * Başlıktan dosya adı türetir: "Müzik ambiyans tanımı" → "muzik-ambiyans-tanimi".
 * Türkçe harfler ASCII karşılığına çevrilir, çünkü dosya adı olarak kullanılıyor.
 *
 * @param {string} title
 * @returns {string} boş kalırsa ''
 */
export function promptIdFrom(title) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' };
  return String(title)
    // Noktalı/noktasız İ'ler küçültmeden önce ASCII'ye çekilir: JS'te
    // "İ".toLowerCase() birleşen noktalı bir karakter üretiyor ve sonraki
    // süzgeçten düşerdi ("Işık" → "sk").
    .replace(/İ/g, 'I')
    .replace(/ı/g, 'i')
    // Küçültme önce: büyük harfli Ç/Ğ/Ö/Ş/Ü de haritadan geçsin.
    .toLowerCase()
    .replace(/[çğöşü]/g, (ch) => map[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

/**
 * Klasördeki prompt kimlikleri (doğal sırada). Klasör yoksa boş liste —
 * kütüphane henüz kullanılmamış olabilir, bu hata değil.
 *
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function listPromptIds({ dir = PROMPT_LIBRARY_DIR } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => basename(entry.name, '.json'))
    .filter((id) => PROMPT_ID_PATTERN.test(id))
    .sort((a, b) => a.localeCompare(b, 'tr'));
}

/**
 * Tek promptu okur ve doğrular.
 *
 * @param {string} id
 * @param {{ dir?: string }} [options]
 * @returns {Promise<{ id: string, title: string, text: string, note: string|null,
 *   tags: string[], updatedAt: string|null, path: string }>}
 */
export async function loadPrompt(id, { dir = PROMPT_LIBRARY_DIR } = {}) {
  if (typeof id !== 'string' || !PROMPT_ID_PATTERN.test(id)) {
    throw new PromptLibraryError(String(id), [
      `prompt kimliği küçük harf kebab-case olmalı, verilen: ${JSON.stringify(id)}`,
    ]);
  }

  const path = join(dir, `${id}.json`);
  let json;
  try {
    json = await readJsonFile(path);
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new PromptLibraryError(id, ['prompt bulunamadı']);
    throw new PromptLibraryError(path, [
      cause instanceof SyntaxError
        ? `JSON ayrıştırılamadı: ${cause.message}`
        : `dosya okunamadı: ${cause.code ?? cause.message}`,
    ]);
  }

  return { ...validatePrompt(json, id), path };
}

/** Kütüphanedeki tüm promptlar. Bozuk dosya listeyi düşürmez, `error` ile döner. */
export async function listPrompts({ dir = PROMPT_LIBRARY_DIR } = {}) {
  const prompts = [];
  for (const id of await listPromptIds({ dir })) {
    try {
      prompts.push(await loadPrompt(id, { dir }));
    } catch (error) {
      if (!(error instanceof PromptLibraryError)) throw error;
      // Elle bozulan bir dosya yüzünden kütüphanenin tamamı açılmaz olmasın.
      prompts.push({ id, title: id, text: '', note: null, tags: [], updatedAt: null, path: join(dir, `${id}.json`), error: error.message });
    }
  }
  return prompts;
}

/**
 * Promptu yazar (yeni ya da üzerine). Doğrulama burada: geçersiz içerik diske
 * hiç gitmez.
 *
 * @param {{ id: string, title: string, text: string, note?: string|null, tags?: string[] }} input
 * @param {{ dir?: string, now?: () => Date }} [options]
 * @returns {Promise<object>} yazılan prompt
 */
export async function writePrompt(input, { dir = PROMPT_LIBRARY_DIR, now = () => new Date() } = {}) {
  const prompt = validatePrompt(input, input?.id);
  prompt.updatedAt = now().toISOString();

  const record = {
    title: prompt.title,
    text: prompt.text,
    ...(prompt.note === null ? {} : { note: prompt.note }),
    tags: prompt.tags,
    updatedAt: prompt.updatedAt,
  };
  // Kütüphane ilk promptla doğar: klasör önceden kurulmuş olmayabilir.
  await mkdir(dir, { recursive: true });
  await writeTextFile(join(dir, `${prompt.id}.json`), JSON.stringify(record, null, 2) + '\n');
  return prompt;
}

/**
 * Promptu siler. Var olmayan kimlik hata: kullanıcı yanlış şeyi sildiğini
 * sanmasın.
 *
 * @param {string} id
 * @param {{ dir?: string }} [options]
 */
export async function deletePrompt(id, { dir = PROMPT_LIBRARY_DIR } = {}) {
  if (typeof id !== 'string' || !PROMPT_ID_PATTERN.test(id)) {
    throw new PromptLibraryError(String(id), [`prompt kimliği geçersiz: ${JSON.stringify(id)}`]);
  }
  if (!(await listPromptIds({ dir })).includes(id)) {
    throw new PromptLibraryError(id, ['prompt bulunamadı']);
  }
  await rm(join(dir, `${id}.json`), { force: true });
  return id;
}

/**
 * Prompt nesnesini doğrular ve normalize eder. Bütün sorunlar tek seferde
 * bildirilir (prep/styles.js ile aynı yaklaşım).
 *
 * @param {unknown} json
 * @param {unknown} id dosya adından gelen kimlik
 */
function validatePrompt(json, id) {
  const problems = [];
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new PromptLibraryError(String(id), ['kök bir nesne olmalı']);
  }

  if (typeof id !== 'string' || !PROMPT_ID_PATTERN.test(id)) {
    problems.push(`kimlik küçük harf kebab-case olmalı, verilen: ${JSON.stringify(id)}`);
  }

  const title = typeof json.title === 'string' ? json.title.trim() : '';
  if (title === '') problems.push('title boş olamaz');
  else if (title.length > PROMPT_LIMITS.title) {
    problems.push(`title en fazla ${PROMPT_LIMITS.title} karakter (verilen: ${title.length})`);
  }

  // Metin normalize edilir (BOM/CRLF): panoya kopyalanan metin her yerde aynı olsun.
  const text = typeof json.text === 'string' ? normalizeText(json.text).trim() : '';
  if (text === '') problems.push('text boş olamaz');
  else if (text.length > PROMPT_LIMITS.text) {
    problems.push(`text en fazla ${PROMPT_LIMITS.text} karakter (verilen: ${text.length})`);
  }

  let note = null;
  if (json.note !== undefined && json.note !== null) {
    if (typeof json.note !== 'string') problems.push('note metin olmalı');
    else {
      note = normalizeText(json.note).trim() || null;
      if (note && note.length > PROMPT_LIMITS.note) {
        problems.push(`note en fazla ${PROMPT_LIMITS.note} karakter (verilen: ${note.length})`);
      }
    }
  }

  let tags = ['general'];
  if (json.tags !== undefined) {
    if (!Array.isArray(json.tags)) problems.push('tags dizi olmalı');
    else {
      const unknown = json.tags.filter((t) => !PROMPT_TAGS.includes(t));
      if (unknown.length > 0) {
        problems.push(`bilinmeyen etiket: ${unknown.map((t) => JSON.stringify(t)).join(', ')} — geçerli: ${PROMPT_TAGS.join(', ')}`);
      } else {
        tags = [...new Set(json.tags)];
        if (tags.length === 0) tags = ['general'];
      }
    }
  }

  const updatedAt = typeof json.updatedAt === 'string' ? json.updatedAt : null;

  if (problems.length > 0) throw new PromptLibraryError(String(id), problems);
  return { id, title, text, note, tags, updatedAt };
}
