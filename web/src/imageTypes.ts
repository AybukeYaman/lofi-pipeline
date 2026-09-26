/**
 * Yüklenebilen görsel türleri — sunucudaki core/files.js IMAGE_EXTENSIONS ile aynı liste.
 * .jfif/.pjpeg/.pjp aynı JPEG biçimi (Chrome Windows'ta resmi .jfif kaydeder).
 */
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.pjpeg', '.pjp'];

/** <input type="file"> accept değeri. */
export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.join(',');

/** Kullanıcıya gösterilen kısa liste. */
export const IMAGE_FORMATS_LABEL = '.jpg, .png, .webp, .jfif';
