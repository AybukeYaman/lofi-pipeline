/**
 * Suno şarkı üretim adaptörü (Faz 11d) — sağlayıcıdan bağımsız iş mantığı.
 *
 * Sorumlulukları:
 * - SUNO_GENERATE_API_KEY'i .env/ortamdan okumak (gemini.js ile aynı yöntem)
 * - Üretim işini başlatmak (generateSong) ve durumunu sormak (checkStatus)
 * - İş bitene kadar exponential backoff ile beklemek (waitForSong)
 *
 * Somut sağlayıcı (apiframe.ai vb.) burada YOK; SunoGenerateProvider arayüzü
 * arkasında izole. Bkz. prep/suno-generate-provider.js.
 *
 * API key yalnızca sağlayıcıya context olarak verilir; bu katman onu ne URL'e koyar
 * ne de log'lar — hata mesajları SunoGenerateError içinde sanitize edilir.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { SunoGenerateError, sanitizeApiKey } from './suno-generate-errors.js';
import { STATUS, assertProvider, normalizeStatusResult } from './suno-generate-provider.js';

export { STATUS } from './suno-generate-provider.js';

/** Polling: ilk bekleme ve üst sınır (gemini.js'teki backoff deseniyle aynı). */
export const INITIAL_BACKOFF_MS = 2000;
export const MAX_BACKOFF_MS = 60000;
/** Şarkı üretimi dakikalar sürebilir; 40 deneme ~25 dk'lık pencereye denk gelir. */
export const MAX_POLL_ATTEMPTS = 40;

/**
 * Repo kökündeki .env dosyasını yüklemeyi dener.
 * @param {string} [repoRoot]
 */
export function loadEnv(repoRoot = process.cwd()) {
  const envPath = resolve(repoRoot, '.env');
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // .env okunamadıysa sessizce devam et
    }
  }
}

/**
 * API key'i ortam değişkenlerinden alır.
 * @param {object} [env]
 * @returns {string | undefined}
 */
export function getApiKey(env = process.env) {
  return env.SUNO_GENERATE_API_KEY;
}

/**
 * Key'i çözer; yoksa anlaşılır hata fırlatır.
 * @param {{ apiKey?: string, env?: object, repoRoot?: string }} [options]
 * @returns {string}
 */
export function resolveApiKey({ apiKey, env, repoRoot } = {}) {
  if (!env) loadEnv(repoRoot || process.cwd());
  const key = apiKey || getApiKey(env || process.env);
  if (!key) {
    throw new SunoGenerateError(
      'SUNO_GENERATE_API_KEY bulunamadı. Lütfen .env dosyasına veya ortam değişkenlerine SUNO_GENERATE_API_KEY ekleyin.',
      { status: 401 },
    );
  }
  return key;
}

/**
 * Deneme sırasına göre bekleme süresi: 2s, 4s, 8s… MAX_BACKOFF_MS tavanıyla.
 * Sağlayıcı Retry-After benzeri bir süre verdiyse ona uyulur (yine tavana tabi).
 *
 * @param {number} attempt 1'den başlar
 * @param {{ initialMs?: number, maxMs?: number, retryAfterMs?: number | null }} [options]
 * @returns {number}
 */
export function computeBackoff(attempt, { initialMs = INITIAL_BACKOFF_MS, maxMs = MAX_BACKOFF_MS, retryAfterMs = null } = {}) {
  const base = retryAfterMs && retryAfterMs > 0
    ? retryAfterMs
    : initialMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(base, maxMs);
}

/**
 * Bekleme (testlerde sleepFn ile anında ilerletilir — gemini.js'teki desen).
 * @param {number} ms
 * @param {typeof setTimeout} [sleepFn]
 * @returns {Promise<void>}
 */
function delay(ms, sleepFn) {
  if (sleepFn) return new Promise((done) => sleepFn(done, ms));
  return new Promise((done) => setTimeout(done, ms));
}

/** Sağlayıcıdan gelen beklenmedik hatayı SunoGenerateError'a sarar. */
function wrapProviderError(err, { jobId, secrets }) {
  if (err instanceof SunoGenerateError) return err;
  if (err?.name === 'AbortError') return err;
  return new SunoGenerateError(`Suno üretim sağlayıcısı hatası: ${err?.message ?? err}`, { jobId, secrets, details: err });
}

/** Zaten iptal edilmiş bir signal ile işe başlamayalım. */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('İşlem iptal edildi.');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * Şarkı üretim işini başlatır.
 *
 * @param {string} prompt
 * @param {object} options
 * @param {import('./suno-generate-provider.js').SunoGenerateProvider} options.provider
 * @param {string} [options.style]
 * @param {string} [options.title]
 * @param {boolean} [options.instrumental]
 * @param {string} [options.model]
 * @param {string} [options.apiKey]
 * @param {object} [options.env]
 * @param {string} [options.repoRoot]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} jobId
 */
export async function generateSong(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new SunoGenerateError('Şarkı üretimi için prompt boş olamaz.');
  }

  const provider = assertProvider(options.provider);
  const apiKey = resolveApiKey(options);
  const { style, title, instrumental, model, signal } = options;

  throwIfAborted(signal);

  let result;
  try {
    result = await provider.generateSong(
      { prompt: prompt.trim(), style, title, instrumental, model },
      { apiKey, signal },
    );
  } catch (err) {
    throw wrapProviderError(err, { secrets: [apiKey] });
  }

  const jobId = result?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new SunoGenerateError(`Sağlayıcı geçerli bir jobId döndürmedi (${provider.name ?? 'provider'}).`, {
      details: result,
      secrets: [apiKey],
    });
  }
  return jobId;
}

/**
 * Tek atışlık durum sorgusu — beklemez, retry yapmaz.
 * Bekleyerek sonuç almak için waitForSong kullan.
 *
 * @param {string} jobId
 * @param {object} options generateSong ile aynı provider/key/env seçenekleri
 * @returns {Promise<{ status: 'pending'|'done'|'failed', audioUrl: string | null, error: string | null }>}
 */
export async function checkStatus(jobId, options = {}) {
  if (typeof jobId !== 'string' || !jobId) {
    throw new SunoGenerateError('checkStatus için jobId zorunlu.');
  }

  const provider = assertProvider(options.provider);
  const apiKey = resolveApiKey(options);
  const { signal } = options;

  throwIfAborted(signal);

  let raw;
  try {
    raw = await provider.checkStatus({ jobId }, { apiKey, signal });
  } catch (err) {
    throw wrapProviderError(err, { jobId, secrets: [apiKey] });
  }

  const result = normalizeStatusResult(raw ?? {});
  return { ...result, error: result.error ? sanitizeApiKey(result.error, [apiKey]) : null };
}

/**
 * İş bitene kadar exponential backoff ile durumu yoklar.
 *
 * - 'done'   → { jobId, audioUrl } döner
 * - 'failed' → SunoGenerateError fırlatır
 * - geçici hata (retryable) → beklenip tekrar denenir, deneme hakkı tükenirse fırlatılır
 * - deneme hakkı biterse → SunoGenerateError { timedOut: true }
 *
 * @param {string} jobId
 * @param {object} options checkStatus seçenekleri +
 * @param {typeof setTimeout} [options.sleepFn] testte beklemeyi anında geçmek için
 * @param {number} [options.maxAttempts]
 * @param {number} [options.initialBackoffMs]
 * @param {number} [options.maxBackoffMs]
 * @param {(info: { attempt: number, status: string, waitMs: number }) => void} [options.onProgress]
 * @returns {Promise<{ jobId: string, audioUrl: string }>}
 */
export async function waitForSong(jobId, options = {}) {
  const {
    sleepFn,
    maxAttempts = MAX_POLL_ATTEMPTS,
    initialBackoffMs = INITIAL_BACKOFF_MS,
    maxBackoffMs = MAX_BACKOFF_MS,
    onProgress,
    signal,
  } = options;

  let lastRetryableError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfAborted(signal);

    let status = STATUS.PENDING;
    let audioUrl = null;
    let failureMessage = null;
    let retryAfterMs = null;

    try {
      const result = await checkStatus(jobId, options);
      status = result.status;
      audioUrl = result.audioUrl;
      failureMessage = result.error;
      lastRetryableError = null;
    } catch (err) {
      if (!(err instanceof SunoGenerateError) || !err.retryable) throw err;
      lastRetryableError = err;
      retryAfterMs = err.retryAfterMs ?? null;
    }

    if (status === STATUS.DONE) return { jobId, audioUrl };

    if (status === STATUS.FAILED) {
      throw new SunoGenerateError(
        `Şarkı üretimi başarısız (${jobId})${failureMessage ? `: ${failureMessage}` : '.'}`,
        { jobId },
      );
    }

    if (attempt === maxAttempts) break;

    const waitMs = computeBackoff(attempt, { initialMs: initialBackoffMs, maxMs: maxBackoffMs, retryAfterMs });
    onProgress?.({ attempt, status, waitMs });
    await delay(waitMs, sleepFn);
  }

  if (lastRetryableError) throw lastRetryableError;

  throw new SunoGenerateError(
    `Şarkı üretimi ${maxAttempts} denemede tamamlanmadı (${jobId}). İş sağlayıcıda sürüyor olabilir.`,
    { jobId, timedOut: true },
  );
}
