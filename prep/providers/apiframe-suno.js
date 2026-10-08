/**
 * apiframe.ai Suno sağlayıcısı (11e) — SunoGenerateProvider sözleşmesinin somut hali.
 *
 * Şema (doğrulandı 2026-09-16, https://apiframe.ai/docs/music/suno.mdx,
 * /docs/music.mdx, /docs/jobs/get.mdx):
 *   POST {base}/music/generate  → 202 { jobId, status: "QUEUED" }
 *     gövde: { prompt, model: "suno", sunoParams: { custom_mode, instrumental,
 *              model_version, title, style, negative_tags, style_weight,
 *              weirdness_constraint } }
 *   GET  {base}/jobs/{id}       → { id, status: QUEUED|PROCESSING|COMPLETED|FAILED,
 *                                   result: { tracks: [{ audioUrl, ... }] } | null, error }
 *   Auth: "X-API-Key: <key>" (dokümandaki başlık; Bearer değil)
 *
 * Bu dosya yalnızca HTTP şemasını bilir; bekleme/backoff/key okuma
 * prep/suno-generate.js'te kalır. Key yalnızca header'da taşınır.
 */

import { SunoGenerateError } from '../suno-generate-errors.js';

export const APIFRAME_BASE_URL = 'https://api.apiframe.ai/v2';
export const REQUEST_TIMEOUT_MS = 30000;

export const MODEL_VERSIONS = Object.freeze(['V4', 'V4_5', 'V4_5ALL', 'V4_5PLUS', 'V5', 'V5_5']);
export const DEFAULT_MODEL_VERSION = 'V5_5';

/** Geçici hatalar: polling bunları bekleyip tekrar dener. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Dokümandaki alan önce; diğerleri yalnızca şema değişirse devreye girer ve loglanır. */
const JOB_ID_FIELDS = ['jobId', 'id', 'job_id', 'task_id'];
const AUDIO_URL_FIELDS = ['audioUrl', 'audio_url', 'url', 'streamAudioUrl'];

/** Retry-After (saniye ya da HTTP tarihi) → ms. */
function retryAfterMs(response) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function firstField(object, fields) {
  for (const field of fields) {
    if (object && object[field] !== undefined && object[field] !== null && object[field] !== '') {
      return { field, value: object[field] };
    }
  }
  return null;
}

/**
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchFn]
 * @param {string} [deps.baseUrl]
 * @param {number} [deps.timeoutMs]
 * @param {(message: string) => void} [deps.log] şema sapması bildirimleri
 * @returns {import('../suno-generate-provider.js').SunoGenerateProvider}
 */
export function createApiframeSunoProvider({
  fetchFn = fetch,
  baseUrl = APIFRAME_BASE_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = (message) => console.warn(`[apiframe] ${message}`),
} = {}) {
  async function request(method, path, { body, apiKey, signal, jobId }) {
    const secrets = [apiKey];
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new SunoGenerateError(`apiframe bağlantı hatası: ${cause?.message ?? cause}`, {
        retryable: true, jobId, secrets, details: cause,
      });
    }

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Gövde JSON değilse aşağıda durum koduna göre karar verilir.
    }

    if (!response.ok) {
      const detail = data?.error ?? data?.message ?? text.slice(0, 200);
      throw new SunoGenerateError(`apiframe HTTP ${response.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}${hintFor(response.status)}`, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        retryAfterMs: retryAfterMs(response),
        jobId,
        secrets,
        details: data ?? text,
      });
    }
    if (data === null || typeof data !== 'object') {
      throw new SunoGenerateError(`apiframe geçersiz JSON yanıtı döndürdü (HTTP ${response.status}).`, {
        status: response.status, jobId, secrets, details: text.slice(0, 500),
      });
    }
    return data;
  }

  return {
    name: 'apiframe',

    async generateSong({ prompt, style, title, instrumental, model, negativeTags, styleWeight, weirdness }, { apiKey, signal }) {
      const modelVersion = model ?? DEFAULT_MODEL_VERSION;
      if (!MODEL_VERSIONS.includes(modelVersion)) {
        throw new SunoGenerateError(`Geçersiz Suno model_version: "${modelVersion}". Geçerli: ${MODEL_VERSIONS.join(', ')}`);
      }

      const sunoParams = {
        // style/title verildiyse custom mod: Suno bu alanları doğrudan kullanır.
        custom_mode: Boolean(style || title),
        instrumental: Boolean(instrumental),
        model_version: modelVersion,
        title,
        style,
        negative_tags: negativeTags || undefined,
        style_weight: styleWeight,
        weirdness_constraint: weirdness,
      };

      const data = await request('POST', '/music/generate', {
        body: { prompt, model: 'suno', sunoParams },
        apiKey,
        signal,
      });

      const found = firstField(data, JOB_ID_FIELDS);
      if (!found || typeof found.value !== 'string') {
        throw new SunoGenerateError('apiframe yanıtında job id bulunamadı.', { details: data, secrets: [apiKey] });
      }
      if (found.field !== JOB_ID_FIELDS[0]) log(`job id "${found.field}" alanından okundu (beklenen: jobId).`);
      return { jobId: found.value };
    },

    async checkStatus({ jobId }, { apiKey, signal }) {
      const data = await request('GET', `/jobs/${encodeURIComponent(jobId)}`, { apiKey, signal, jobId });

      const tracks = Array.isArray(data.result?.tracks) ? data.result.tracks : [];
      const audioUrls = [];
      for (const track of tracks) {
        const found = firstField(track, AUDIO_URL_FIELDS);
        if (!found) continue;
        if (found.field !== AUDIO_URL_FIELDS[0]) log(`ses adresi "${found.field}" alanından okundu (beklenen: audioUrl, iş ${jobId}).`);
        audioUrls.push(found.value);
      }
      if (String(data.status).toUpperCase() === 'COMPLETED' && audioUrls.length === 0) {
        log(`iş ${jobId} COMPLETED ama result.tracks[] içinde ses adresi yok; alanlar: ${Object.keys(data.result ?? {}).join(', ') || '(result boş)'}`);
      }

      return {
        status: data.status,
        audioUrl: audioUrls[0],
        audioUrls,
        error: typeof data.error === 'string' ? data.error : undefined,
        raw: data,
      };
    },
  };
}

function hintFor(status) {
  switch (status) {
    case 401: return ' — SUNO_GENERATE_API_KEY geçersiz ya da eksik.';
    case 402: return ' — apiframe kredisi yetersiz.';
    default: return '';
  }
}

