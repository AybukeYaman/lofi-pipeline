/**
 * Prompt kütüphanesi API'si — kullanıcının kendi promptları için CRUD.
 *
 * Tek sorumluluk: HTTP gövdesini doğrulayıp prep/prompt-library.js'e çevirmek
 * ve hataları durum koduna eşlemek. Dosya biçimini ve doğrulamayı bilmez.
 *
 * Kütüphane projeye bağlı değil: promptlar hangi aşamada olduğuna bakılmadan
 * her an listelenip kopyalanabilir (kullanıcı isteği).
 */

import {
  PROMPT_ID_PATTERN, PROMPT_LIBRARY_DIR, PROMPT_LIMITS, PROMPT_TAGS, PromptLibraryError,
  deletePrompt, listPrompts, loadPrompt, promptIdFrom, writePrompt,
} from '../prep/prompt-library.js';
import { ApiError, parseBody } from './project-api.js';

/** Aynı promptu iki istek birlikte yazmasın. */
const writing = new Set();

/** Prompt gövdesi: başlık ve metin zorunlu, not ve etiketler isteğe bağlı. */
const PROMPT_BODY = { title: 'string', text: 'string', note: 'string', tags: 'array' };

/**
 * Kütüphanedeki promptlar. Bozuk dosya listeyi düşürmez, `error` alanıyla gelir.
 *
 * @param {{ dir?: string }} [options]
 */
export async function getPrompts({ dir = PROMPT_LIBRARY_DIR } = {}) {
  const prompts = await listPrompts({ dir });
  return {
    prompts: prompts.map(describe),
    tags: PROMPT_TAGS,
    limits: PROMPT_LIMITS,
  };
}

/** Tek prompt. */
export async function getPrompt(id, { dir = PROMPT_LIBRARY_DIR } = {}) {
  return describe(await load(id, dir));
}

/**
 * Prompt ekler. Kimlik başlıktan türetilir; aynı kimlik varsa 409.
 *
 * @param {unknown} body `{ title, text, note?, tags? }`
 */
export async function createPrompt(body, { dir = PROMPT_LIBRARY_DIR } = {}) {
  const input = parseBody(body, PROMPT_BODY, ['title', 'text']);
  const id = promptIdFrom(input.title);
  if (!PROMPT_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'Title must contain at least one letter or digit', { title: input.title });
  }

  return exclusive(id, async () => {
    if ((await listPrompts({ dir })).some((prompt) => prompt.id === id)) {
      throw new ApiError(409, 'Prompt already exists', { id });
    }
    return { prompt: describe(await write({ ...input, id }, dir)) };
  });
}

/**
 * Promptu günceller. Verilmeyen alanlar korunur; başlık değişse de kimlik
 * SABİT kalır — kimlik dosya adı ve arayüzdeki bağlantı, başlık düzeltilince
 * kopyalama bağlantısının kırılması istenmez.
 *
 * @param {unknown} body `{ title?, text?, note?, tags? }` — note: null notu siler
 */
export async function updatePrompt(id, body, { dir = PROMPT_LIBRARY_DIR } = {}) {
  // `note: null` notu siler. parseBody tür denetimi yaptığı için null bir
  // metin alanında reddedilirdi; niyeti ayırıp gövdenin kalanını doğrulatıyoruz.
  const isPlain = body !== null && typeof body === 'object' && !Array.isArray(body);
  const clearNote = isPlain && body.note === null;
  const { note: _omitted, ...rest } = isPlain ? body : {};
  const input = parseBody(clearNote ? rest : (body ?? {}), PROMPT_BODY);
  if (clearNote) input.note = null;

  return exclusive(id, async () => {
    const existing = await load(id, dir);
    const next = {
      id: existing.id,
      title: input.title ?? existing.title,
      text: input.text ?? existing.text,
      note: input.note === undefined ? existing.note : input.note,
      tags: input.tags ?? existing.tags,
    };
    return { prompt: describe(await write(next, dir)) };
  });
}

/** Promptu siler. */
export async function removePrompt(id, { dir = PROMPT_LIBRARY_DIR } = {}) {
  return exclusive(id, async () => {
    try {
      return { ok: true, deleted: await deletePrompt(id, { dir }) };
    } catch (error) {
      throw toApiError(error, id);
    }
  });
}

// ---------------------------------------------------------------- yardimcilar

/** İstemciye giden biçim — dosya yolu sızdırılmaz. */
function describe(prompt) {
  return {
    id: prompt.id,
    title: prompt.title,
    text: prompt.text,
    note: prompt.note ?? null,
    tags: prompt.tags ?? [],
    updatedAt: prompt.updatedAt ?? null,
    ...(prompt.error ? { error: prompt.error } : {}),
  };
}

async function load(id, dir) {
  if (typeof id !== 'string' || !PROMPT_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'Invalid prompt id');
  }
  try {
    return await loadPrompt(id, { dir });
  } catch (error) {
    throw toApiError(error, id);
  }
}

async function write(input, dir) {
  try {
    return await writePrompt(input, { dir });
  } catch (error) {
    throw toApiError(error, input.id);
  }
}

/** PromptLibraryError → 404 (yok) ya da 422 (içerik geçersiz). */
function toApiError(error, id) {
  if (!(error instanceof PromptLibraryError)) return error;
  if (error.problems.includes('prompt bulunamadı')) {
    return new ApiError(404, `Prompt "${id}" not found`);
  }
  return new ApiError(422, error.message, { problems: error.problems });
}

async function exclusive(id, fn) {
  if (writing.has(id)) throw new ApiError(409, 'Prompt is being updated');
  writing.add(id);
  try {
    return await fn();
  } finally {
    writing.delete(id);
  }
}
