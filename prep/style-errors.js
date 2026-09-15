/**
 * StyleBuildError — Suno style/exclude/cleaner işlemleri sırasında
 * fırlatılan özel hata sınıfı.
 */
export class StyleBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StyleBuildError';
  }
}
