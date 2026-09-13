/**
 * En-boy oranı değeri — ayrıştırma ve hata tipi.
 *
 * Tek sorumluluk: "16:9" gibi bir metni sayıya çevirmek. Kırpma hesabı
 * (hangi pikseller kesilecek) steps/01-video-prep.js'te; konfig doğrulaması
 * (core/config.js) aynı ayrıştırıcıyı kullanır ki iki yer farklı biçim kabul etmesin.
 */

export class AspectError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'AspectError';
  }
}

/**
 * `"16:9"` → `{ w: 16, h: 9, label: '16:9' }`. `16/9` ve `16x9` de kabul edilir.
 * @param {string} aspect
 */
export function parseAspect(aspect) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/.exec(String(aspect));
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw new AspectError(`Geçersiz en-boy oranı: "${aspect}" (beklenen biçim: 16:9)`);
  }
  return { w: Number(match[1]), h: Number(match[2]), label: `${match[1]}:${match[2]}` };
}
