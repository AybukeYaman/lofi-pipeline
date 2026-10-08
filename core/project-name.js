/**
 * Windows klasör adı kuralları — saf, Node bağımlılığı yok.
 *
 * Hem sunucu (prep/scaffold.js üzerinden) hem de web formu bunu kullanır.
 * Form eskiden kuralları kendi regex'iyle tekrarlıyordu ve sapmıştı: boşluğu
 * yasaklıyor (projenin kendi adlandırma düzeni `video3-Neo Tokyo Night`
 * reddediliyordu), ayrılmış adları (CON, NUL...) ise kaçırıyordu. Kural tek
 * yerde dursun diye ayrıldı.
 */

/** Boşluk ve `&` serbest (HANDOFF bölüm 9). */
export function validateVideoName(name) {
  if (typeof name !== 'string' || name.trim() === '') return ['isim boş olamaz'];

  const problems = [];
  const invalid = [...new Set(name.match(/[<>:"/\\|?*\x00-\x1f]/g) ?? [])];
  if (invalid.length > 0) {
    problems.push(`isim Windows'ta geçersiz karakter içeriyor: ${invalid.map((c) => JSON.stringify(c)).join(' ')}`);
  }
  if (/[. ]$/.test(name)) problems.push('isim nokta ya da boşlukla bitemez (Windows sessizce kırpıyor)');
  if (/^\s/.test(name)) problems.push('isim boşlukla başlayamaz');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) problems.push(`"${name}" Windows'ta ayrılmış bir ad`);
  return problems;
}
