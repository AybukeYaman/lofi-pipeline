/**
 * Gemini API HTTP client katmanı.
 *
 * Sorumlulukları:
 * - process.loadEnvFile ile .env yüklemek (varsa)
 * - Gemini API isteklerini yapmak (generateContent, listModels)
 * - API key'i header'da göndermek (`x-goog-api-key`), asla URL veya log/hatalara sızdırmamak
 * - Geçici hatalarda (429, 500, 503) retry (exponential backoff / Retry-After) uygulamak
 * - Kalıcı veya günlük kota hatalarında (400, 403, 404, PerDay quota) retry yapmamak
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const DEFAULT_GEMINI_MODEL = 'gemini-1.5-flash';
export const MAX_RETRIES = 3;
export const MAX_BACKOFF_MS = 60000;
/** Tek deneme üst sınırı: asılı kalan bağlantı süreci süresiz tutmasın. */
export const REQUEST_TIMEOUT_MS = 90000;

export class GeminiError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status]
   * @param {unknown} [options.details]
   * @param {boolean} [options.quotaExceeded]
   */
  constructor(message, { status, details, quotaExceeded = false } = {}) {
    super(sanitizeApiKey(message));
    this.name = 'GeminiError';
    this.status = status;
    this.details = details;
    this.quotaExceeded = quotaExceeded;
  }
}

/**
 * Metindeki olası API key ifadelerini temizler.
 * @param {string} text
 * @returns {string}
 */
function sanitizeApiKey(text) {
  if (!text) return text;
  return text.replace(/AIzaSy[A-Za-z0-9_-]{33}/g, '***REDACTED***');
}

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
  return env.GEMINI_API_KEY;
}

/**
 * Kullanılacak modeli belirler.
 * @param {object} [env]
 * @returns {string}
 */
export function getModel(env = process.env) {
  return env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
}

/**
 * Delay fonksiyonu (testlerde kolay mock'lanması için `sleepFn` imkanı verilir).
 * @param {number} ms
 * @param {typeof setTimeout} [sleepFn]
 * @returns {Promise<void>}
 */
function delay(ms, sleepFn) {
  if (sleepFn) {
    return new Promise((resolve) => sleepFn(resolve, ms));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Hata cevabından Retry-After veya Gemini RetryInfo süresini ms cinsinden çıkarır.
 * @param {Headers} headers
 * @param {any} body
 * @returns {number | null}
 */
function parseRetryDelay(headers, body) {
  if (headers) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseFloat(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }

  if (body && Array.isArray(body.error?.details)) {
    for (const detail of body.error.details) {
      if (detail['@type']?.includes('RetryInfo') && detail.retryDelay) {
        // örn "1.5s" veya "10s"
        const seconds = parseFloat(detail.retryDelay);
        if (!isNaN(seconds) && seconds > 0) {
          return seconds * 1000;
        }
      }
    }
  }

  return null;
}

/**
 * Hatanın günlük kota (PerDay limit) aşımı olup olmadığını kontrol eder.
 * @param {any} body
 * @param {string} message
 * @returns {boolean}
 */
function isPerDayQuotaError(body, message = '') {
  const msgLower = (message || '').toLowerCase();
  if (msgLower.includes('perday') || msgLower.includes('per day')) return true;

  if (body && Array.isArray(body.error?.details)) {
    for (const detail of body.error.details) {
      if (detail.reason === 'QUOTA_EXCEEDED_PER_DAY' || detail.reason === 'RATE_LIMIT_EXCEEDED_PER_DAY') {
        return true;
      }
      if (JSON.stringify(detail).toLowerCase().includes('perday')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * HTTP isteğini retry mantığıyla gerçekleştirir.
 *
 * @param {string} url
 * @param {RequestInit} options
 * @param {object} [config]
 * @param {typeof fetch} [config.fetchFn]
 * @param {typeof setTimeout} [config.sleepFn]
 * @param {number} [config.maxRetries]
 * @returns {Promise<any>}
 */
async function fetchWithRetry(url, options, { fetchFn = fetch, sleepFn, maxRetries = MAX_RETRIES } = {}) {
  let attempt = 0;

  while (true) {
    let response;
    let body;
    let rawText = '';

    try {
      response = await fetchFn(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      rawText = await response.text();
      try {
        body = JSON.parse(rawText);
      } catch {
        body = null;
      }
    } catch (err) {
      // Network hatası (ör. DNS / connection refused)
      attempt++;
      if (attempt > maxRetries) {
        throw new GeminiError(`Ağ hatası: ${err.message}`);
      }
      const backoff = Math.min(1000 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
      await delay(backoff, sleepFn);
      continue;
    }

    if (response.ok) {
      return body;
    }

    const status = response.status;
    const errorMessage = body?.error?.message || rawText || `HTTP ${status}`;

    const isQuotaPerDay = isPerDayQuotaError(body, errorMessage);

    // 400, 403, 404, PerDay quota durumlarında retry yapma
    const isRetryableStatus = (status === 429 || status === 500 || status === 503) && !isQuotaPerDay;

    if (!isRetryableStatus || attempt >= maxRetries) {
      throw new GeminiError(`Gemini API hatası (${status}): ${errorMessage}`, {
        status,
        details: body?.error,
        quotaExceeded: isQuotaPerDay,
      });
    }

    attempt++;

    // Retry bekleme süresi belirle
    let waitMs = parseRetryDelay(response.headers, body);
    if (waitMs === null) {
      waitMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s...
    }
    waitMs = Math.min(waitMs, MAX_BACKOFF_MS);

    await delay(waitMs, sleepFn);
  }
}

/**
 * Gemini generateContent API çağrısı.
 *
 * @param {object} params
 * @param {any[]} params.contents - Gemini API content dizisi (ör. [{ parts: [{ text: '...' }] }])
 * @param {string} [params.model] - Model adı (verilmezse GEMINI_MODEL veya varsayılan)
 * @param {object} [params.generationConfig] - Opsiyonel üretici ayarları
 * @param {string} [params.apiKey] - Opsiyonel doğrudan API key
 * @param {object} [params.options] - Testing & env opsiyonları
 * @param {typeof fetch} [params.options.fetchFn]
 * @param {typeof setTimeout} [params.options.sleepFn]
 * @param {object} [params.options.env]
 * @param {string} [params.options.repoRoot]
 * @returns {Promise<any>}
 */
export async function generateContent({
  contents,
  model,
  generationConfig,
  apiKey,
  options = {},
} = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  loadEnv(repoRoot);

  const env = options.env || process.env;
  const key = apiKey || getApiKey(env);

  if (!key) {
    throw new GeminiError('GEMINI_API_KEY bulunamadı. Lütfen .env dosyasına veya ortam değişkenlerine GEMINI_API_KEY ekleyin.', {
      status: 401,
    });
  }

  const selectedModel = model || getModel(env);
  // Model adında 'models/' öneki yoksa ekle (v1beta API için)
  const modelPath = selectedModel.startsWith('models/') ? selectedModel : `models/${selectedModel}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent`;

  const bodyData = { contents };
  if (generationConfig) {
    bodyData.generationConfig = generationConfig;
  }

  const fetchOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(bodyData),
  };

  return fetchWithRetry(url, fetchOptions, {
    fetchFn: options.fetchFn,
    sleepFn: options.sleepFn,
    maxRetries: options.maxRetries,
  });
}

/**
 * Gemini listModels API çağrısı.
 *
 * @param {object} [params]
 * @param {string} [params.apiKey]
 * @param {object} [params.options]
 * @param {typeof fetch} [params.options.fetchFn]
 * @param {typeof setTimeout} [params.options.sleepFn]
 * @param {object} [params.options.env]
 * @param {string} [params.options.repoRoot]
 * @returns {Promise<{ models: Array<{ name: string, displayName: string, description: string }> }>}
 */
export async function listModels({ apiKey, options = {} } = {}) {
  const repoRoot = options.repoRoot || process.cwd();
  loadEnv(repoRoot);

  const env = options.env || process.env;
  const key = apiKey || getApiKey(env);

  if (!key) {
    throw new GeminiError('GEMINI_API_KEY bulunamadı. Lütfen .env dosyasına veya ortam değişkenlerine GEMINI_API_KEY ekleyin.', {
      status: 401,
    });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models';

  const fetchOptions = {
    method: 'GET',
    headers: {
      'x-goog-api-key': key,
    },
  };

  return fetchWithRetry(url, fetchOptions, {
    fetchFn: options.fetchFn,
    sleepFn: options.sleepFn,
    maxRetries: options.maxRetries,
  });
}
