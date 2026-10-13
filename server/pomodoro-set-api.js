/**
 * Kayıtlı Pomodoro setleri API'si — kullanıcının kendi durum listeleri için CRUD.
 *
 * Tek sorumluluk: HTTP gövdesini doğrulayıp prep/pomodoro-sets.js'e çevirmek ve
 * hataları durum koduna eşlemek. Dosya biçimini ve durum kurallarını bilmez.
 * Hazır düzenler (50/10, 30/10) listede `builtin: true` ile gelir; değiştirilemez
 * ve silinemez. Set projeden bağımsızdır (yalnızca ad, dakika, bip).
 */

import { POMODORO_PRESETS } from '../core/pomodoro-plan.js';
import {
  BUILTIN_SET_IDS, POMODORO_SET_DIR, POMODORO_SET_ID_PATTERN, POMODORO_SET_LIMITS, PomodoroSetError,
  deletePomodoroSet, listPomodoroSets, loadPomodoroSet, setIdFrom, writePomodoroSet,
} from '../prep/pomodoro-sets.js';
import { createExclusive } from './exclusive.js';
import { ApiError, parseBody } from './project-api.js';

/** Aynı seti iki istek birlikte yazmasın. */
const exclusive = createExclusive('Set is being updated');

/** Program gövdesi: ad ve setler (ya da tek setin `statuses` kısayolu); içeriği prep/pomodoro-sets.js doğrular. */
const SET_BODY = { name: 'string', sets: 'array', statuses: 'array' };

/**
 * Hazır düzenler + kayıtlı setler (hazırlar önde). Bozuk dosya listeyi düşürmez.
 *
 * @param {{ dir?: string }} [options]
 */
export async function getPomodoroSets({ dir = POMODORO_SET_DIR } = {}) {
  const saved = await listPomodoroSets({ dir });
  return {
    sets: [...POMODORO_PRESETS.map(describeBuiltin), ...saved.map(describe)],
    limits: POMODORO_SET_LIMITS,
  };
}

/** Tek set (hazır düzen de olabilir). */
export async function getPomodoroSet(id, { dir = POMODORO_SET_DIR } = {}) {
  const builtin = POMODORO_PRESETS.find((preset) => setIdFrom(preset.id) === id);
  if (builtin) return describeBuiltin(builtin);
  return describe(await load(id, dir));
}

/**
 * Set ekler. Kimlik addan türetilir; aynı kimlik (ya da hazır düzen adı) varsa 409.
 *
 * @param {unknown} body `{ name, sets }` (ya da tek set için `{ name, statuses }`)
 */
export async function createPomodoroSet(body, { dir = POMODORO_SET_DIR } = {}) {
  const input = parseBody(body, SET_BODY, ['name']);
  if (input.sets === undefined && input.statuses === undefined) throw new ApiError(400, 'Missing field: sets');
  const id = setIdFrom(input.name);
  if (!POMODORO_SET_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'Name must contain at least one letter or digit', { name: input.name });
  }
  if (BUILTIN_SET_IDS.includes(id)) {
    throw new ApiError(409, 'This name belongs to a built-in set', { id });
  }

  return exclusive(id, async () => {
    if ((await listPomodoroSets({ dir })).some((set) => set.id === id)) {
      throw new ApiError(409, 'Set already exists', { id });
    }
    return { set: describe(await write({ ...input, id }, dir)) };
  });
}

/**
 * Seti günceller. Verilmeyen alan korunur; ad değişse de kimlik SABİT kalır
 * (dosya adı ve arayüzdeki bağlantı değişmesin).
 *
 * @param {unknown} body `{ name?, sets? | statuses? }`
 */
export async function updatePomodoroSet(id, body, { dir = POMODORO_SET_DIR } = {}) {
  const input = parseBody(body ?? {}, SET_BODY);
  rejectBuiltin(id);

  return exclusive(id, async () => {
    const existing = await load(id, dir);
    const changesProgram = input.sets !== undefined || input.statuses !== undefined;
    const next = {
      id: existing.id,
      name: input.name ?? existing.name,
      // Yapı verilmediyse kayıtlı setler olduğu gibi kalır; verildiyse eskisinin yerine geçer.
      ...(changesProgram ? { sets: input.sets, statuses: input.statuses } : { sets: existing.sets }),
    };
    return { set: describe(await write(next, dir)) };
  });
}

/** Seti siler (hazır düzenler silinemez). */
export async function removePomodoroSet(id, { dir = POMODORO_SET_DIR } = {}) {
  rejectBuiltin(id);
  return exclusive(id, async () => {
    try {
      return { ok: true, deleted: await deletePomodoroSet(id, { dir }) };
    } catch (error) {
      throw toApiError(error, id);
    }
  });
}

// ---------------------------------------------------------------- yardimcilar

function rejectBuiltin(id) {
  if (BUILTIN_SET_IDS.includes(id)) throw new ApiError(409, 'Built-in sets cannot be changed or deleted');
}

/** İstemciye giden biçim — dosya yolu sızdırılmaz. */
function describe(set) {
  return {
    id: set.id,
    name: set.name,
    builtin: false,
    sets: set.sets,
    updatedAt: set.updatedAt ?? null,
    ...(set.error ? { error: set.error } : {}),
  };
}

function describeBuiltin(preset) {
  return {
    id: setIdFrom(preset.id),
    name: preset.id,
    builtin: true,
    // Görüntü programa girmez (kayıtlılarla aynı şekil).
    sets: preset.sets.map((set) => ({ ...set, steps: set.steps.map(({ visual, ...step }) => step) })),
    updatedAt: null,
  };
}

async function load(id, dir) {
  if (typeof id !== 'string' || !POMODORO_SET_ID_PATTERN.test(id)) {
    throw new ApiError(400, 'Invalid set id');
  }
  try {
    return await loadPomodoroSet(id, { dir });
  } catch (error) {
    throw toApiError(error, id);
  }
}

async function write(input, dir) {
  try {
    return await writePomodoroSet(input, { dir });
  } catch (error) {
    throw toApiError(error, input.id);
  }
}

/** PomodoroSetError → 404 (yok) ya da 422 (içerik geçersiz). */
function toApiError(error, id) {
  if (!(error instanceof PomodoroSetError)) return error;
  if (error.problems.includes('set bulunamadı')) {
    return new ApiError(404, `Set "${id}" not found`);
  }
  return new ApiError(422, error.message, { problems: error.problems });
}
