/**
 * Kayıtlı Pomodoro setleri — kullanıcının kendi durum listelerinin kalıcı deposu.
 *
 * Tek sorumluluk: `pomodoro-sets/*.json` dosyalarını okumak, doğrulamak ve
 * yazmak. HTTP ve arayüz bu modülün dışında (server/pomodoro-set-api.js).
 *
 * "Set" adı dosyada/rotada tarihsel: arayüzde bunlar KAYITLI PROGRAMLAR. Bir kayıt YALNIZCA
 * program yapısıdır: setler (ad, tekrar) ve adımları (ad, süre, tür, bip açık/kapalı). Görüntüler projeye özeldir, sete GİRMEZ (dosyada `visual` olsa bile
 * okunurken atılır); tur sayısı ve GET READY görüntüsü de projeye aittir.
 * Set/adım kuralları `core/pomodoro-plan.js` `normalizeSetList`'te — burada
 * kopyalanmaz. Hazır programlar (50/10, 30/10, 50/10/50/20, Klasik 25/5) kodda `POMODORO_PRESETS` olarak
 * durur, klasöre yazılmaz.
 *
 * Biçim `prep/prompt-library.js` ile aynı kalıpta: dosya adı = slug, içerik tek nesne.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POMODORO_PRESETS, flattenSets, normalizeSetList, serializeSets } from '../core/pomodoro-plan.js';
import { readJsonFile, writeTextFile } from '../core/workspace.js';
import { PROMPT_ID_PATTERN, promptIdFrom } from './prompt-library.js';

/** Kullanıcı setlerinin klasörü. */
export const POMODORO_SET_DIR = fileURLToPath(new URL('../pomodoro-sets/', import.meta.url));

/** Dosya adı kuralı ve başlıktan ad türetme prompt kütüphanesiyle aynı (küçük harf kebab-case). */
export const POMODORO_SET_ID_PATTERN = PROMPT_ID_PATTERN;
export const setIdFrom = promptIdFrom;

/** Ad sınırı. */
export const POMODORO_SET_LIMITS = { name: 60 };

/** Hazır düzenlerin kimlikleri ("50/10" → "50-10"): kullanıcı bunlarla aynı adı kullanamaz. */
export const BUILTIN_SET_IDS = POMODORO_PRESETS.map((preset) => setIdFrom(preset.id));

export class PomodoroSetError extends Error {
  /**
   * @param {string} source
   * @param {string[]} problems
   */
  constructor(source, problems) {
    super(`set geçersiz (${source}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'PomodoroSetError';
    this.source = source;
    this.problems = problems;
  }
}

/**
 * Klasördeki set kimlikleri (doğal sırada). Klasör yoksa boş liste — kimse set
 * kaydetmemiş olabilir, bu hata değil.
 *
 * @param {{ dir?: string }} [options]
 * @returns {Promise<string[]>}
 */
export async function listPomodoroSetIds({ dir = POMODORO_SET_DIR } = {}) {
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
    .filter((id) => POMODORO_SET_ID_PATTERN.test(id))
    .sort((a, b) => a.localeCompare(b, 'tr'));
}

/**
 * Tek seti okur ve doğrular.
 *
 * @param {string} id
 * @param {{ dir?: string }} [options]
 * @returns {Promise<{ id: string, name: string, sets: object[],
 *   statuses: object[], updatedAt: string|null }>}
 */
export async function loadPomodoroSet(id, { dir = POMODORO_SET_DIR } = {}) {
  if (typeof id !== 'string' || !POMODORO_SET_ID_PATTERN.test(id)) {
    throw new PomodoroSetError(String(id), [
      `set kimliği küçük harf kebab-case olmalı, verilen: ${JSON.stringify(id)}`,
    ]);
  }

  const path = join(dir, `${id}.json`);
  let json;
  try {
    json = await readJsonFile(path);
  } catch (cause) {
    if (cause.code === 'ENOENT') throw new PomodoroSetError(id, ['set bulunamadı']);
    throw new PomodoroSetError(path, [
      cause instanceof SyntaxError
        ? `JSON ayrıştırılamadı: ${cause.message}`
        : `dosya okunamadı: ${cause.code ?? cause.message}`,
    ]);
  }

  return validateSet(json, id);
}

/** Kayıtlı tüm setler. Bozuk dosya listeyi düşürmez, `error` ile döner. */
export async function listPomodoroSets({ dir = POMODORO_SET_DIR } = {}) {
  const sets = [];
  for (const id of await listPomodoroSetIds({ dir })) {
    try {
      sets.push(await loadPomodoroSet(id, { dir }));
    } catch (error) {
      if (!(error instanceof PomodoroSetError)) throw error;
      // Elle bozulan bir dosya yüzünden bütün setler açılmaz olmasın.
      sets.push({ id, name: id, sets: [], statuses: [], updatedAt: null, error: error.message });
    }
  }
  return sets;
}

/**
 * Seti yazar (yeni ya da üzerine). Doğrulama burada: geçersiz içerik diske hiç gitmez.
 *
 * @param {{ id: string, name: string, statuses: unknown }} input
 * @param {{ dir?: string, now?: () => Date }} [options]
 * @returns {Promise<object>} yazılan set
 */
export async function writePomodoroSet(input, { dir = POMODORO_SET_DIR, now = () => new Date() } = {}) {
  const set = validateSet(input, input?.id);
  if (BUILTIN_SET_IDS.includes(set.id)) {
    throw new PomodoroSetError(set.id, ['bu ad hazır bir düzene ait (50/10, 30/10), başka bir ad seç']);
  }
  set.updatedAt = now().toISOString();

  const record = {
    name: set.name,
    // Yalnızca yapı: görüntü yok (validateSet zaten attı); basit program `statuses`, çoklu set `sets`.
    ...serializeSets(set.sets),
    updatedAt: set.updatedAt,
  };
  // Klasör ilk setle doğar: önceden kurulmuş olmayabilir.
  await mkdir(dir, { recursive: true });
  await writeTextFile(join(dir, `${set.id}.json`), JSON.stringify(record, null, 2) + '\n');
  return set;
}

/**
 * Seti siler. Var olmayan kimlik hata: kullanıcı yanlış şeyi sildiğini sanmasın.
 *
 * @param {string} id
 * @param {{ dir?: string }} [options]
 */
export async function deletePomodoroSet(id, { dir = POMODORO_SET_DIR } = {}) {
  if (typeof id !== 'string' || !POMODORO_SET_ID_PATTERN.test(id)) {
    throw new PomodoroSetError(String(id), [`set kimliği geçersiz: ${JSON.stringify(id)}`]);
  }
  if (!(await listPomodoroSetIds({ dir })).includes(id)) {
    throw new PomodoroSetError(id, ['set bulunamadı']);
  }
  await rm(join(dir, `${id}.json`), { force: true });
  return id;
}

/**
 * Set nesnesini doğrular ve normalize eder; bütün sorunlar tek seferde bildirilir.
 * Durumlardaki `visual` atılır (görüntü sete girmez).
 *
 * @param {unknown} json
 * @param {unknown} id dosya adından gelen kimlik
 */
function validateSet(json, id) {
  const problems = [];
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new PomodoroSetError(String(id), ['kök bir nesne olmalı']);
  }

  if (typeof id !== 'string' || !POMODORO_SET_ID_PATTERN.test(id)) {
    problems.push(`kimlik küçük harf kebab-case olmalı, verilen: ${JSON.stringify(id)}`);
  }

  const name = typeof json.name === 'string' ? json.name.trim() : '';
  if (name === '') problems.push('name boş olamaz');
  else if (name.length > POMODORO_SET_LIMITS.name) {
    problems.push(`name en fazla ${POMODORO_SET_LIMITS.name} karakter (verilen: ${name.length})`);
  }

  // Görüntü programa girmez: adımlardaki `visual` okunurken atılır. `sets` yoksa `statuses` TEK set olur.
  const stripVisual = (steps) => (Array.isArray(steps)
    ? steps.map((item) => (item !== null && typeof item === 'object' && !Array.isArray(item) ? { ...item, visual: undefined } : item))
    : steps);
  const rawSets = Array.isArray(json.sets)
    ? json.sets.map((item) => (
      item !== null && typeof item === 'object' && !Array.isArray(item)
        ? { ...item, steps: stripVisual(item.steps ?? item.statuses) }
        : item
    ))
    : [{ steps: stripVisual(json.statuses) }];
  const listed = normalizeSetList(rawSets, 'sets');
  problems.push(...listed.problems);

  if (problems.length > 0) throw new PomodoroSetError(String(id), problems);

  // Okunan programda da görüntü alanı yok (proje kendi görüntüsünü korur).
  const sets = listed.sets.map((set) => ({ ...set, steps: set.steps.map(({ visual, ...step }) => step) }));
  return {
    id,
    name,
    sets,
    statuses: flattenSets(sets),
    updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : null,
  };
}
