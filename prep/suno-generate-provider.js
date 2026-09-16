/**
 * SunoGenerateProvider — şarkı üretimi sağlayıcı arayüzü (Faz 11d).
 *
 * İş mantığı (prep/suno-generate.js) hiçbir sağlayıcının somut HTTP şemasını bilmez;
 * yalnızca buradaki sözleşmeyi bilir. Sağlayıcı değişince (apiframe → başkası)
 * sadece yeni bir provider dosyası yazılır, iş mantığı ve testler aynı kalır.
 *
 * NOT: Bu fazda somut sağlayıcı implementasyonu (apiframe.ai) YOK.
 * Ticari lisans netleşmeden canlı istek atılmayacak — bkz. CLAUDE.md Faz 11d.
 *
 * Sözleşme:
 *
 *   provider.name: string
 *
 *   provider.generateSong(request, context) => Promise<{ jobId: string }>
 *     request : { prompt: string, style?: string, title?: string,
 *                 instrumental?: boolean, model?: string }
 *     context : { apiKey: string, signal?: AbortSignal }
 *
 *   provider.checkStatus(query, context) => Promise<RawStatus>
 *     query    : { jobId: string }
 *     RawStatus: { status: string, audioUrl?: string, error?: string, raw?: unknown }
 *
 * Sağlayıcı hata durumunda SunoGenerateError fırlatır; geçici hatalarda
 * `retryable: true` verir ki waitForSong backoff ile beklemeye devam etsin.
 * API key ASLA URL'e konmaz — yalnızca Authorization header'ında taşınır.
 *
 * @typedef {object} SunoGenerateProvider
 * @property {string} name
 * @property {(request: object, context: object) => Promise<{ jobId: string }>} generateSong
 * @property {(query: { jobId: string }, context: object) => Promise<object>} checkStatus
 */

import { SunoGenerateError } from './suno-generate-errors.js';

/** İş mantığının tanıdığı üç durum. */
export const STATUS = Object.freeze({ PENDING: 'pending', DONE: 'done', FAILED: 'failed' });

/** Sağlayıcıların kullandığı yaygın durum adları → STATUS. */
const STATUS_ALIASES = new Map(Object.entries({
  pending: STATUS.PENDING,
  queued: STATUS.PENDING,
  submitted: STATUS.PENDING,
  processing: STATUS.PENDING,
  running: STATUS.PENDING,
  streaming: STATUS.PENDING,
  in_progress: STATUS.PENDING,
  starting: STATUS.PENDING,
  done: STATUS.DONE,
  complete: STATUS.DONE,
  completed: STATUS.DONE,
  success: STATUS.DONE,
  succeeded: STATUS.DONE,
  finished: STATUS.DONE,
  failed: STATUS.FAILED,
  error: STATUS.FAILED,
  cancelled: STATUS.FAILED,
  canceled: STATUS.FAILED,
  rejected: STATUS.FAILED,
}));

/**
 * Sağlayıcının durum adını üç durumdan birine indirger.
 * Tanınmayan durum 'pending' sayılır: bilinmeyen bir ad yüzünden bitmiş bir işi
 * "failed" diye atmaktansa beklemek daha güvenli (waitForSong zaten zaman aşımı koyuyor).
 *
 * @param {unknown} value
 * @returns {'pending'|'done'|'failed'}
 */
export function normalizeStatus(value) {
  if (typeof value !== 'string') return STATUS.PENDING;
  return STATUS_ALIASES.get(value.trim().toLowerCase()) ?? STATUS.PENDING;
}

/**
 * Sağlayıcının ham cevabını iş mantığının beklediği biçime çevirir.
 * 'done' ama audioUrl yoksa iş henüz kullanılabilir değildir → pending.
 *
 * @param {{ status?: unknown, audioUrl?: unknown, error?: unknown }} raw
 * @returns {{ status: 'pending'|'done'|'failed', audioUrl: string | null, error: string | null }}
 */
export function normalizeStatusResult(raw = {}) {
  const audioUrl = typeof raw.audioUrl === 'string' && /^https?:\/\//.test(raw.audioUrl) ? raw.audioUrl : null;
  let status = normalizeStatus(raw.status);
  if (status === STATUS.DONE && !audioUrl) status = STATUS.PENDING;
  return { status, audioUrl, error: typeof raw.error === 'string' && raw.error ? raw.error : null };
}

/**
 * Verilen nesnenin SunoGenerateProvider sözleşmesine uyduğunu doğrular.
 * @param {unknown} provider
 * @returns {SunoGenerateProvider}
 */
export function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new SunoGenerateError('Suno üretim sağlayıcısı verilmedi (provider zorunlu).');
  }
  for (const method of ['generateSong', 'checkStatus']) {
    if (typeof provider[method] !== 'function') {
      throw new SunoGenerateError(`Geçersiz Suno üretim sağlayıcısı: ${method}() eksik.`);
    }
  }
  return /** @type {SunoGenerateProvider} */ (provider);
}
