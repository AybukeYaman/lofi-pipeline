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
