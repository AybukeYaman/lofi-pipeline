/**
 * Mimi Galerisi API — üretilip indirilen resim ve videoların ortak deposu.
 *
 * Tek sorumluluk: makineye özel ORTAK bir klasörü (DEFAULT_MIMI_DIR) listelemek,
 * içine dosya yazmak, önizleme için akıtmak ve dosyayı Geri Dönüşüm Kutusu'na
 * taşımak. Projelerden bağımsızdır — hiçbir project.json'a dokunmaz, montaj
 * zincirine girmez. Klasör mantığı `prep/ambients.js` DEFAULT_AMBIENT_DIR ile
 * aynı: kullanıcı dosyayı Explorer'dan da atabilsin diye sabit bir yol.
 */

import { mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ffmpeg as runFfmpeg } from '../core/ffmpeg.js';
import { IMAGE_EXTENSIONS, imageMimeType, naturalCompare, uniqueFileName } from '../core/files.js';
import { moveFileToTrash } from '../core/trash.js';
// Ad doğrulaması kütüphane API'siyle ortak: tek bir "düz ad" kuralı olsun.
import { isSafeName } from './music-library-api.js';
import { ApiError, openFolderOnOs } from './project-api.js';

/** Mimi için üretilen görsel/videoların ortak klasörü. */
export const DEFAULT_MIMI_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\mimi-galeri';

/** Video uzantısı → MIME. Tarayıcının <video> ile oynatabildikleri. */
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
};

export const MIMI_VIDEO_EXTENSIONS = Object.keys(VIDEO_MIME_TYPES);
export const MIMI_EXTENSIONS = [...IMAGE_EXTENSIONS, ...MIMI_VIDEO_EXTENSIONS];

/**
 * Resimden üretilen loop videonun uzantı öneki: `kedi.png` → `kedi.loop.mp4`.
 * Eşleştirme ADA dayanıyor (ayrı bir kayıt dosyası YOK): kullanıcı dosyayı
 * Explorer'dan silse/taşısa bile galeri diskteki gerçeği gösterir.
 */
export const LOOP_SUFFIX = '.loop.mp4';

/** Loop video varsayılanları — resimden üretilen sabit kare videosu. */
export const LOOP_DEFAULTS = { seconds: 5, fps: 30, crf: 21, preset: 'medium' };

/** Kullanıcının seçebileceği loop süreleri (saniye). */
export const LOOP_SECONDS_CHOICES = [5, 10, 15, 30];

/** base64 çözüldükten sonraki üst sınır — tek bir video için. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/** @param {string} ext nokta dahil */
function mimiMimeType(ext) {
  const lower = ext.toLowerCase();
  return imageMimeType(lower) ?? VIDEO_MIME_TYPES[lower] ?? null;
}

/** @param {string} ext */
function mimiKind(ext) {
  return imageMimeType(ext.toLowerCase()) ? 'image' : 'video';
}

function isInside(parent, target) {
  const rel = relative(parent, target);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}

/** Sembolik bağla klasörün dışına çıkılmasını engeller. */
async function realPathInside(parentDir, candidatePath) {
  const [realParent, realCandidate] = await Promise.all([
    realpath(parentDir).catch(() => null),
    realpath(candidatePath).catch(() => null),
  ]);
  return realParent && realCandidate && isInside(realParent, realCandidate) ? realCandidate : null;
}

/**
 * Galeriyi diskten okur. Klasör yoksa oluşturulur — ilk açılışta hata
 * göstermek yerine boş galeri gösterilsin.
 *
 * @param {{ mimiDir?: string }} [options]
 * @returns {Promise<{ dir: string, items: object[], error: string|null }>}
 */
export async function getMimiGallery({ mimiDir = DEFAULT_MIMI_DIR } = {}) {
  const dir = resolve(mimiDir);
  let error = null;
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    error = `Mimi klasörü oluşturulamadı (${cause.code ?? cause.message}): ${dir}`;
    return { dir, items: [], error };
  }

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    return { dir, items: [], error: `Mimi klasörü okunamadı (${cause.code ?? cause.message}): ${dir}` };
  }

  const allowed = new Set(MIMI_EXTENSIONS.map((ext) => ext.toLowerCase()));
  const names = entries
    .filter((entry) => entry.isFile() && allowed.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort(naturalCompare);

  const items = [];
  for (const file of names) {
    const info = await stat(join(dir, file)).catch(() => null);
    if (!info?.isFile()) continue;
    const ext = extname(file).toLowerCase();
    items.push({
      file,
      name: basename(file, ext),
      kind: mimiKind(ext),
      ext,
      size: info.size,
      mtimeMs: info.mtimeMs,
      previewUrl: `/api/mimi/assets/${encodeURIComponent(file)}`,
    });
  }

  // En yeni üstte: galeriye bakma nedeni çoğunlukla "en son indirdiğim".
  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { dir, items: linkLoopPairs(items), error };
}

/**
 * Resim ↔ loop video eşlerini bağlar. İsim kuralı tek kaynak:
 * `<ad><resim uzantısı>` ile `<ad>.loop.mp4` aynı işin iki hali.
 *
 * Her resme `loopVideo` (üretilmiş video) ve `needsVideo` (henüz yok) ,
 * her loop videoya `sourceImage` (hangi resimden geldiği) eklenir. Elle
 * atılmış videolarda ikisi de null kalır — onlar dönüşüm şeridi göstermez.
 *
 * @param {object[]} items
 * @returns {object[]} aynı sıradaki zenginleştirilmiş kopyalar
 */
function linkLoopPairs(items) {
  const loopByBase = new Map();
  for (const item of items) {
    if (isLoopName(item.file)) loopByBase.set(loopBaseOf(item.file).toLowerCase(), item.file);
  }
  const imageByBase = new Map();
  for (const item of items) {
    if (item.kind === 'image') imageByBase.set(item.name.toLowerCase(), item.file);
  }

  return items.map((item) => {
    if (item.kind === 'image') {
      const loopVideo = loopByBase.get(item.name.toLowerCase()) ?? null;
      return { ...item, role: 'image', loopVideo, sourceImage: null, needsVideo: loopVideo === null };
    }
    if (isLoopName(item.file)) {
      const sourceImage = imageByBase.get(loopBaseOf(item.file).toLowerCase()) ?? null;
      return { ...item, role: 'loop', loopVideo: null, sourceImage, needsVideo: false };
    }
    return { ...item, role: 'video', loopVideo: null, sourceImage: null, needsVideo: false };
  });
}

/** `kedi.loop.mp4` mi? (büyük/küçük harfe duyarsız — Windows) */
function isLoopName(file) {
  return file.toLowerCase().endsWith(LOOP_SUFFIX);
}

/** `kedi.loop.mp4` → `kedi` */
function loopBaseOf(file) {
  return file.slice(0, file.length - LOOP_SUFFIX.length);
}

/**
 * Resimden üretilecek loop videonun adı: `kedi.png` → `kedi.loop.mp4`.
 * @param {string} imageFile
 */
export function loopNameFor(imageFile) {
  return `${basename(imageFile, extname(imageFile))}${LOOP_SUFFIX}`;
}

/**
 * Bir resmi loop videoya çevirir (sabit kare, sessiz, h264/yuv420p).
 *
 * Neden sabit kare: resim boyunca hareket yok, video loop'landığında dikiş
 * görünmez — `steps/01-video-prep.js` tek resim modundaki mantığın aynısı
 * (orada `-loop 1 -framerate … -t …`). Çift sayı denetimi (`trunc(iw/2)*2`)
 * zorunlu: tek sayılı en/boy libx264'te yuv420p ile encode edilemiyor.
 *
 * Çıktı aynı klasöre `<ad>.loop.mp4` olarak yazılır; ad sabit tutuluyor ki
 * galeri resmi ve videosunu eşleştirebilsin. Dosya varsa `overwrite`
 * istenmediyse 409 döner (yanlışlıkla üzerine yazılmasın).
 *
 * @param {unknown} body `{ file, seconds?, overwrite? }`
 * @returns {Promise<object>} güncel galeri + `{ file, source, seconds }`
 */
export async function convertMimiImageToLoop(body, {
  mimiDir = DEFAULT_MIMI_DIR,
  ffmpegFn = runFfmpeg,
} = {}) {
  const { file, seconds, overwrite = false } = body ?? {};
  if (!isSafeName(file)) throw new ApiError(400, 'Invalid file name');
  if (!imageMimeType(extname(file))) throw new ApiError(400, 'Only images can be converted to a loop video');

  const durationSeconds = normalizeLoopSeconds(seconds);

  const dir = resolve(mimiDir);
  const realImage = await realPathInside(dir, join(dir, file));
  if (!realImage) throw new ApiError(404, 'Image not found');

  const outputName = loopNameFor(file);
  const outputPath = join(dir, outputName);
  const existing = await stat(outputPath).catch(() => null);
  if (existing?.isFile() && !overwrite) {
    throw new ApiError(409, `Loop video zaten var: ${outputName}`, { file: outputName });
  }

  try {
    await ffmpegFn([
      '-loop', '1',
      '-framerate', String(LOOP_DEFAULTS.fps),
      '-t', String(durationSeconds),
      '-i', realImage,
      // Tek sayılı en/boy yuv420p'de encode edilemiyor; ayrıca ölçek
      // değiştirilmiyor — kullanıcının ürettiği çözünürlük korunur.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
      '-an',
      '-c:v', 'libx264',
      '-crf', String(LOOP_DEFAULTS.crf),
      '-preset', LOOP_DEFAULTS.preset,
      '-movflags', '+faststart',
      '-y', outputPath,
    ]);
  } catch (cause) {
    throw new ApiError(500, `Loop video üretilemedi: ${cause.message}`);
  }

  const gallery = await getMimiGallery({ mimiDir });
  return { ...gallery, file: outputName, source: file, seconds: durationSeconds };
}

/** Süre seçimi: verilmezse varsayılan, listede yoksa 400. */
function normalizeLoopSeconds(seconds) {
  if (seconds === undefined || seconds === null) return LOOP_DEFAULTS.seconds;
  const value = Number(seconds);
  if (!LOOP_SECONDS_CHOICES.includes(value)) {
    throw new ApiError(400, `Loop süresi şunlardan biri olmalı: ${LOOP_SECONDS_CHOICES.join(', ')} sn`);
  }
  return value;
}

/**
 * Dosyayı ortak klasöre YAZAR. Ad çakışırsa benzersizleştirilir
 * (yüklenen dosya sessizce ezilmesin). Yanıt galerinin güncel hali.
 *
 * @param {unknown} body `{ name, data }` — data base64 (data URL de kabul)
 */
export async function uploadMimiAsset(body, { mimiDir = DEFAULT_MIMI_DIR } = {}) {
  const { name, data } = body ?? {};
  if (!isSafeName(name)) throw new ApiError(400, 'Invalid file name');
  if (typeof data !== 'string' || data.trim() === '') {
    throw new ApiError(400, 'File data is empty');
  }

  const ext = extname(name).toLowerCase();
  if (!MIMI_EXTENSIONS.includes(ext)) {
    throw new ApiError(400, `Unsupported format (${ext}). Supported: ${MIMI_EXTENSIONS.join(', ')}`);
  }

  const base64Clean = data.includes(',') ? data.split(',')[1] : data;
  const buffer = Buffer.from(base64Clean, 'base64');
  if (buffer.length === 0) throw new ApiError(400, 'File data is empty');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new ApiError(422, `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
  }

  const dir = resolve(mimiDir);
  await mkdir(dir, { recursive: true });
  const uniqueName = await uniqueFileName(dir, name);
  await writeFile(join(dir, uniqueName), buffer);

  const gallery = await getMimiGallery({ mimiDir });
  return { ...gallery, file: uniqueName };
}

/**
 * Dosyayı ortak klasörden kaldırır — kalıcı silme değil, Geri Dönüşüm
 * Kutusu'na taşır (yanlışlıkla silinen üretim geri alınabilsin).
 */
export async function deleteMimiAsset(file, { mimiDir = DEFAULT_MIMI_DIR, trashFn = moveFileToTrash } = {}) {
  if (!isSafeName(file)) throw new ApiError(400, 'Invalid file name');

  const dir = resolve(mimiDir);
  const realFile = await realPathInside(dir, join(dir, file));
  if (!realFile) throw new ApiError(404, 'File not found');

  try {
    await trashFn(realFile);
  } catch (cause) {
    throw new ApiError(500, `Dosya silinemedi: ${cause.message}`);
  }

  return getMimiGallery({ mimiDir });
}

/**
 * Önizleme/indirme için dosyayı akıtır. Video Range isteklerini
 * web-server.js'in sendFile'ı karşılar.
 */
export async function getMimiAsset(file, { mimiDir = DEFAULT_MIMI_DIR } = {}) {
  if (!isSafeName(file)) throw new ApiError(400, 'Invalid file name');

  const contentType = mimiMimeType(extname(file));
  if (!contentType) throw new ApiError(400, 'Unsupported asset format');

  const dir = resolve(mimiDir);
  const realFile = await realPathInside(dir, join(dir, file));
  if (!realFile) throw new ApiError(404, 'Asset not found');

  const info = await stat(realFile).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, 'Asset not found');

  return { path: realFile, size: info.size, contentType };
}

/** Ortak klasörü Explorer'da açar — dosyaları sürükleyip bırakmak için. */
export async function openMimiFolder(_body = {}, {
  mimiDir = DEFAULT_MIMI_DIR,
  openFn = openFolderOnOs,
} = {}) {
  const dir = resolve(mimiDir);
  await mkdir(dir, { recursive: true });
  return { ok: openFn(dir), path: dir };
}
