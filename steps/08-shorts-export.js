/**
 * Aşama 8 — Shorts kesidi render'ı (9:16 dikey çıktı).
 *
 * Tek sorumluluk: kaynak videonun BİR aralığını kırpıp 1080×1920 olarak
 * yazmak. Hangi aralık ve hangi kadraj olduğunu bilmez (onu
 * `core/shorts-plan.js` hesaplar), project.json'a dokunmaz (onu
 * `prep/shorts-file.js` yazar).
 *
 * Kaynak video KOPYALANMAZ: kesitler yalnızca zaman aralığı referansıdır,
 * dosya ancak burada — kullanıcı "Render" dediğinde — üretilir. Böylece 10
 * kesit 10 kopya değil, tek kaynak + 10 kısa çıktı demek.
 *
 * Montaj zinciri (01–07) bu adımdan habersizdir; `build.js` onu çağırmaz.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg as runFfmpeg } from '../core/ffmpeg.js';
import { probe as runProbe } from '../core/probe.js';
import { buildShortsFilter, computeShortsCrop, SHORTS_TARGET } from '../core/shorts-plan.js';

/** Kesit çıktısı — kısa video, görüntü kalitesi öncelikli. */
export const SHORTS_ENCODE = { crf: 20, preset: 'medium', audioBitrate: '192k' };

/**
 * Bir kesidi render eder.
 *
 * `-ss` girişten ÖNCE: ffmpeg anahtar kareye hızlı atlar, yeniden encode
 * ettiğimiz için sonuç kare hassasiyetinde olur (kopyalamada olmazdı).
 * `-t` süreyi girişten sonra sınırlar.
 *
 * @param {{
 *   sourcePath: string,
 *   clip: { start: number, end: number, frame: { zoom: number, x: number, y: number } },
 *   outputPath: string,
 *   sourceInfo?: { width: number, height: number, hasAudio?: boolean },
 *   ffmpegFn?: typeof runFfmpeg,
 *   probeFn?: typeof runProbe,
 *   onProgress?: (seconds: number) => void,
 * }} input
 * @returns {Promise<{
 *   outputPath: string,
 *   crop: { width: number, height: number, x: number, y: number },
 *   duration: number,
 *   target: typeof SHORTS_TARGET,
 * }>}
 */
export async function exportShortsClip({
  sourcePath,
  clip,
  outputPath,
  sourceInfo,
  ffmpegFn = runFfmpeg,
  probeFn = runProbe,
  onProgress,
}) {
  const source = sourceInfo ?? await probeFn(sourcePath);
  if (!source.width || !source.height) {
    throw new Error(`Kaynak videonun ölçüsü okunamadı: ${sourcePath}`);
  }

  const crop = computeShortsCrop({
    sourceWidth: source.width,
    sourceHeight: source.height,
    zoom: clip.frame?.zoom,
    x: clip.frame?.x,
    y: clip.frame?.y,
  });
  const duration = Math.round((clip.end - clip.start) * 1000) / 1000;
  if (!(duration > 0)) {
    throw new Error(`Kesit süresi pozitif olmalı (başlangıç ${clip.start}, bitiş ${clip.end}).`);
  }

  await mkdir(dirname(outputPath), { recursive: true });

  // Sessiz kaynakta ses akışı eşlemesi hata verir; ses varsa AAC'ye encode
  // edilir (kesit yeniden encode edildiği için kopyalama zaten mümkün değil).
  const audioArgs = source.hasAudio === false
    ? ['-an']
    : ['-c:a', 'aac', '-b:a', SHORTS_ENCODE.audioBitrate];

  await ffmpegFn([
    '-ss', String(clip.start),
    '-i', sourcePath,
    '-t', String(duration),
    '-vf', buildShortsFilter(crop),
    '-c:v', 'libx264',
    '-crf', String(SHORTS_ENCODE.crf),
    '-preset', SHORTS_ENCODE.preset,
    '-pix_fmt', 'yuv420p',
    ...audioArgs,
    '-movflags', '+faststart',
    '-y', outputPath,
  ], { onProgress });

  return { outputPath, crop, duration, target: SHORTS_TARGET };
}
