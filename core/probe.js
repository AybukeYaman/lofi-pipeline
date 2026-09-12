/**
 * ffprobe sarmalayıcısı — bir medya dosyasının ölçülebilir gerçeklerini döndürür.
 *
 * Tek sorumluluk: dosyayı ölç ve normalize edilmiş düz bir nesne ver.
 * Karar vermez (kırpılsın mı, encode edilsin mi) — o steps/ katmanının işi.
 */

import { access, constants } from 'node:fs/promises';
import { ffprobe } from './ffmpeg.js';

/**
 * Süre karşılaştırmalarında kullanılacak tolerans (saniye).
 * ffprobe format/video/audio akışları için farklı ondalık döndürüyor;
 * tam eşitlik beklemek yanlış negatif üretir. (HANDOFF bölüm 14, madde 5)
 */
export const DURATION_TOLERANCE = 0.5;

export class ProbeError extends Error {
  /**
   * @param {string} message
   * @param {{ path: string, cause?: unknown }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = 'ProbeError';
    this.path = detail.path;
    if (detail.cause !== undefined) this.cause = detail.cause;
  }
}

/**
 * İki sürenin tolerans içinde eşit sayılıp sayılmayacağı.
 * @param {number} a
 * @param {number} b
 * @param {number} [tolerance]
 * @returns {boolean}
 */
export function durationsMatch(a, b, tolerance = DURATION_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

/**
 * `"24/1"` veya `"24000/1001"` biçimindeki kesri ondalığa çevirir.
 * @param {string|undefined} rational
 * @returns {number|null}
 */
function parseRational(rational) {
  if (!rational) return null;
  const [numerator, denominator] = rational.split('/');
  const num = Number(numerator);
  const den = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return num / den;
}

/**
 * Sayıya çevirir; ffprobe eksik değerleri "N/A" olarak döndürüyor.
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === undefined || value === null || value === 'N/A') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * Bir medya dosyasını ölçer.
 *
 * @param {string} path
 * @returns {Promise<{
 *   path: string,
 *   duration: number|null,
 *   size: number|null,
 *   bitrate: number|null,
 *   formatName: string|null,
 *   hasVideo: boolean,
 *   width: number|null,
 *   height: number|null,
 *   fps: number|null,
 *   videoCodec: string|null,
 *   hasAudio: boolean,
 *   audioCodec: string|null,
 *   sampleRate: number|null,
 *   channels: number|null,
 *   audioBitrate: number|null,
 * }>}
 */
export async function probe(path) {
  try {
    await access(path, constants.R_OK);
  } catch (cause) {
    throw new ProbeError(`Dosya okunamıyor: ${path}`, { path, cause });
  }

  let result;
  try {
    result = await ffprobe([
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ]);
  } catch (cause) {
    throw new ProbeError(`ffprobe çalıştırılamadı: ${path}`, { path, cause });
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (cause) {
    throw new ProbeError(`ffprobe JSON çıktısı okunamadı: ${path}`, { path, cause });
  }

  const format = parsed.format ?? {};
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];

  if (streams.length === 0) {
    // Yarım kalmış veya bozuk dosyada tipik durum (bölüm 8, Ctrl+C tuzağı).
    throw new ProbeError(`Dosyada hiç akış yok, bozuk olabilir: ${path}`, { path });
  }

  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  // Süre öncelikle konteynerden; yoksa akıştan türetilir.
  const duration =
    toNumber(format.duration) ??
    toNumber(video?.duration) ??
    toNumber(audio?.duration);

  return {
    path,
    duration,
    size: toNumber(format.size),
    bitrate: toNumber(format.bit_rate),
    formatName: format.format_name ?? null,

    hasVideo: video !== undefined,
    width: toNumber(video?.width),
    height: toNumber(video?.height),
    // avg_frame_rate değişken kare hızında 0/0 gelebiliyor, r_frame_rate'e düş.
    fps: parseRational(video?.avg_frame_rate) || parseRational(video?.r_frame_rate),
    videoCodec: video?.codec_name ?? null,

    hasAudio: audio !== undefined,
    // Gerçek codec: uzantı .m4a olsa da içerik Opus olabiliyor (bölüm 8).
    audioCodec: audio?.codec_name ?? null,
    sampleRate: toNumber(audio?.sample_rate),
    channels: toNumber(audio?.channels),
    audioBitrate: toNumber(audio?.bit_rate),
  };
}
