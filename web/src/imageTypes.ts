/**
 * Yüklenebilen görsel türleri — sunucudaki core/files.js IMAGE_EXTENSIONS ile aynı liste.
 * .jfif/.pjpeg/.pjp aynı JPEG biçimi (Chrome Windows'ta resmi .jfif kaydeder).
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.pjpeg', '.pjp'];

/** <input type="file"> accept değeri. */
export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.join(',');

/** Dosya adı (ya da yolu) bir resim mi — uzantıdan, büyük/küçük harf fark etmez. */
export function isImageName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && IMAGE_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}
