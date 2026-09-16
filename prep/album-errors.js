/**
 * AlbumPlanError — Albüm planlama (prep/album-planner.js) işlemleri sırasında
 * fırlatılan özel hata sınıfı.
 */
export class AlbumPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AlbumPlanError';
  }
}

/**
 * AlbumPromptError — Suno style/negative/title metni üretilemediğinde ya da
 * Suno karakter sınırını aştığında (prep/album-prompt.js). Sınır aşımında
 * `field`, `limit`, `length` dolu gelir; istek gönderilmez.
 */
export class AlbumPromptError extends AlbumPlanError {
  /**
   * @param {string} message
   * @param {{ field?: string, limit?: number, length?: number }} [detail]
   */
  constructor(message, { field, limit, length } = {}) {
    super(message);
    this.name = 'AlbumPromptError';
    this.field = field;
    this.limit = limit;
    this.length = length;
  }
}
