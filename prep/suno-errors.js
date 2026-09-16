/**
 * SunoIngestError — Suno ingest/indirme işlemleri sırasında fırlatılan özel hata sınıfı.
 */
export class SunoIngestError extends Error {
  /**
   * @param {string} message
   * @param {{ notPublic?: boolean, downloadDisabled?: boolean }} [detail] kullanıcı uyarısı gerektiren durumlar:
   *   notPublic link private ya da erişilemez · downloadDisabled Suno bu şarkının indirilmesini kapatmış
   */
  constructor(message, { notPublic = false, downloadDisabled = false } = {}) {
    super(message);
    this.name = 'SunoIngestError';
    this.notPublic = notPublic;
    this.downloadDisabled = downloadDisabled;
  }
}
