/**
 * Ekranlarda tekrar eden biçimlendirmeler.
 *
 * Bunlar sayfa sayfa ayrı ayrı yazılmıştı: `errorText` iki dosyada birebir
 * aynıydı, `formatSize` iki yerde (biri GB basamağını, diğeri null durumunu
 * biliyordu), tarih ise iki sayfada FARKLI biçimde gösteriliyordu.
 *
 * Süre biçimlendiricileri bilerek burada DEĞİL: `formatClock` (geri sayım,
 * `--:--`), `formatDuration` (parça süresi, `m:ss`) ve `formatTimecode`
 * (timeline, ondalıklı `mm:ss.s`) farklı çıktı veriyor, ortaklaştırmak
 * seçenek bayraklarıyla daha karmaşık olurdu.
 */

/** Hata nesnesinden satır içi gösterilecek kısa metin. */
export function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Dosya boyutu — KB / MB / GB. `null` girerse `null` döner. */
export function formatSize(bytes: number): string;
export function formatSize(bytes: number | null): string | null;
export function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Dosya/proje değişiklik zamanı — bütün sayfalarda aynı biçim. */
export function formatDateTime(mtimeMs: number) {
  return new Date(mtimeMs).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
