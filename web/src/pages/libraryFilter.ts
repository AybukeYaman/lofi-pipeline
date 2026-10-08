/**
 * Kütüphane ekranlarının ortak arama süzgeci (Ambiance, Mimi, Promptlar).
 *
 * Arama kutusu üç sayfada üç farklı davranıyordu ve iki uç da hatalıydı:
 *
 * - Düz `toLowerCase()` (Ambiance, Mimi): "İstanbul" araması "istanbul"
 *   yazınca tutmuyordu — "İ" nokta ayrı bir karaktere ayrışıyor.
 * - `toLocaleLowerCase('tr')` (Promptlar): Türkçe yerelde "I" → "ı" olduğu
 *   için "RAIN" yazınca "heavyRain.mp3" bulunamıyordu.
 *
 * Çözüm aramaya uygun harf katlaması: I/İ/ı hepsi düz "i"ye indirilir, böylece
 * dört yazım birbirini bulur. "ş/s" gibi gerçekten farklı harfler ayrı kalır
 * ("kis" araması "Kış"ı getirmez).
 */
function foldForSearch(value: string) {
  return value.replace(/[İIı]/g, 'i').toLowerCase();
}

export function matchesQuery(query: string, ...fields: Array<string | null | undefined>) {
  const needle = foldForSearch(query.trim());
  if (!needle) return true;
  return fields.some((field) => foldForSearch(field ?? '').includes(needle));
}
