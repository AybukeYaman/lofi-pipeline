/**
 * SunoGenerateError — Suno şarkı üretimi (prep/suno-generate.js) sırasında
 * fırlatılan özel hata sınıfı.
 *
 * Mesaj her zaman sanitizeApiKey'den geçer: API key'in log'a, hata yığınına ya da
 * kullanıcıya gösterilen metne sızması imkansız olsun.
 */

/** Bilinen sağlayıcı key biçimleri (Gemini AIzaSy…, OpenAI sk-…, apiframe afk_…). */
const KEY_PATTERNS = [
  /AIzaSy[A-Za-z0-9_-]{33}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bafk_[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi,
  /\b(api[-_]?key|token|authorization)\s*[:=]\s*[A-Za-z0-9._-]{8,}/gi,
];

export const REDACTED = '***REDACTED***';

/**
 * Metindeki olası API key ifadelerini temizler.
 *
 * @param {string} text
 * @param {string[]} [extraSecrets] ortamdan okunan gerçek key'ler; birebir eşleşme ile silinir
 * @returns {string}
 */
export function sanitizeApiKey(text, extraSecrets = []) {
  if (!text) return text;
  let out = String(text);
  for (const secret of extraSecrets) {
    // Kısa/boş değerler yanlışlıkla her yeri maskelemesin.
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of KEY_PATTERNS) {
    out = out.replace(pattern, (match) => (match.includes(REDACTED) ? match : maskMatch(match)));
  }
  return out;
}

/** "Bearer xyz" / "api_key=xyz" gibi eşleşmelerde etiketi koru, değeri maskele. */
function maskMatch(match) {
  const labelled = match.match(/^(\s*[A-Za-z_-]+\s*[:=]?\s*)/);
  if (labelled && /[:=]|bearer/i.test(labelled[1])) return `${labelled[1]}${REDACTED}`;
  return REDACTED;
}

export class SunoGenerateError extends Error {
  /**
   * @param {string} message
   * @param {object} [detail]
   * @param {number} [detail.status] HTTP durum kodu (sağlayıcıdan geldiyse)
   * @param {boolean} [detail.retryable] geçici hata — polling sırasında beklenip tekrar denenebilir
   * @param {number} [detail.retryAfterMs] sağlayıcının önerdiği bekleme (Retry-After); backoff bunu tercih eder
   * @param {boolean} [detail.timedOut] üretim izin verilen deneme sayısında bitmedi
   * @param {string} [detail.jobId]
   * @param {unknown} [detail.details] sağlayıcının ham hata gövdesi
   * @param {string[]} [detail.secrets] mesajdan birebir silinecek gizli değerler
   */
  constructor(message, { status, retryable = false, retryAfterMs, timedOut = false, jobId, details, secrets = [] } = {}) {
    super(sanitizeApiKey(message, secrets));
    this.name = 'SunoGenerateError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.timedOut = timedOut;
    this.jobId = jobId;
    this.details = details;
  }
}
