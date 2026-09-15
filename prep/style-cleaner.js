/**
 * Suno Style string temizlik ve normalizasyon fonksiyonu.
 * Duplicate kelimeleri/etiketleri temizler, fazla virgül ve boşlukları düzenler.
 */

/**
 * Ham stil metnindeki mükerrer öğeleri ve boşluk/virgül fazlalıklarını temizler.
 *
 * @param {string} rawString
 * @returns {string} Cleaned style string
 */
export function cleanStyleString(rawString) {
  if (typeof rawString !== 'string') {
    return '';
  }

  // Virgüllere göre böl, whitespace kırp
  const parts = rawString
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const seen = new Set();
  const cleanedParts = [];

  for (const part of parts) {
    // Birden fazla boşluğu tek boşluğa indir
    const normalizedPart = part.replace(/\s+/g, ' ');
    const lowerKey = normalizedPart.toLowerCase();

    if (!seen.has(lowerKey)) {
      seen.add(lowerKey);
      cleanedParts.push(normalizedPart);
    }
  }

  return cleanedParts.join(', ');
}
