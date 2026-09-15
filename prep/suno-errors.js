/**
 * SunoIngestError — Suno ingest/indirme işlemleri sırasında fırlatılan özel hata sınıfı.
 */
export class SunoIngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SunoIngestError';
  }
}
