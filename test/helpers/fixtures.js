/**
 * Test yardımcıları — yapay medya üretimi ve kare düzeyinde ölçüm.
 *
 * Gerçek albüme bağımlı değil: her fixture lavfi kaynaklarından saniyeler içinde
 * geçici klasörde üretilir. Ölçümler (SSIM, kare sayısı) testlerin "çalıştı"
 * yerine "doğru çalıştı" diyebilmesi için.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ffmpeg, ffprobe } from '../../core/ffmpeg.js';

/**
 * Test başına geçici klasör. `after(() => dir.cleanup())` ile silinir.
 * @param {string} name
 */
export async function tempDir(name) {
  const dir = await mkdtemp(join(tmpdir(), `lofi-test-${name}-`));
  return {
    dir,
    path: (file) => join(dir, file),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Loop'u KAPANMAYAN yapay klip: dokulu bir desen sabit hızla sağa kayar.
 * Ardışık kareler birbirine çok benzer, son kare ile ilk kare hiç benzemez —
 * loop birleşme noktasındaki sıçramayı ölçülebilir kılar.
 *
 * Neredeyse kayıpsız encode (crf 0) — kare karşılaştırmaları kaynak bozulmasıyla
 * kirlenmesin.
 *
 * @param {string} path
 * @param {{ width?: number, height?: number, fps?: number, frames?: number, speed?: number, blur?: number }} [o]
 *   speed: saniyede kayılan piksel · blur: gblur sigma (doku yumuşar, SSIM ölçümü kararlılaşır)
 */
export async function makeDriftingClip(path, o = {}) {
  const { width = 640, height = 510, fps = 24, frames = 124, speed = 60, blur = 4 } = o;
  const duration = frames / fps;
  const sourceWidth = width + Math.ceil(speed * duration) + 2;

  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=${sourceWidth}x${height}:r=${fps}:d=${duration}`,
    '-vf', `${blur > 0 ? `gblur=sigma=${blur},` : ''}crop=${width}:${height}:x='floor(t*${speed})':y=0`,
    '-frames:v', String(frames),
    '-c:v', 'libx264', '-crf', '0', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-y', path,
  ]);
  return path;
}

/**
 * Sabit frekanslı stereo ses.
 *
 * codec 'pcm': örnek sayısı tam — süresi kare sınırına oturması gereken testler
 * için (AAC encoder gecikmesi ve 1024'lük çerçeveler süreyi yuvarlar).
 *
 * @param {string} path
 * @param {{ seconds: number, frequency?: number, sampleRate?: number, codec?: 'aac'|'pcm' }} o
 */
export async function makeTone(path, { seconds, frequency = 440, sampleRate = 48000, codec = 'aac' }) {
  const samples = Math.round(seconds * sampleRate);
  await ffmpeg([
    '-f', 'lavfi', '-i', `sine=f=${frequency}:d=${seconds + 1}:sample_rate=${sampleRate}`,
    '-af', `atrim=end_sample=${samples}`,
    '-ac', '2',
    ...(codec === 'pcm' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']),
    '-y', path,
  ]);
  return path;
}

/**
 * Bir dosyanın i. karesini (0 tabanlı) PNG'ye yazar. İsteğe bağlı ön filtre
 * (ör. kaynağı çıktıyla aynı şekilde kırpmak için).
 *
 * @param {string} input
 * @param {number} index
 * @param {string} output
 * @param {string} [prefilter]
 */
export async function extractFrame(input, index, output, prefilter) {
  const chain = [prefilter, `trim=start_frame=${index}`, 'setpts=PTS-STARTPTS']
    .filter(Boolean).join(',');
  await ffmpeg(['-i', input, '-vf', chain, '-frames:v', '1', '-update', '1', '-y', output]);
  return output;
}

/**
 * İki görüntünün SSIM'i (1 = aynı).
 * @param {string} a
 * @param {string} b
 * @returns {Promise<number>}
 */
export async function ssim(a, b) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-',
  ]);
  const match = /All:\s*([\d.]+)/.exec(stderr);
  if (!match) throw new Error(`SSIM okunamadı: ${a} / ${b}`);
  return Number(match[1]);
}

/**
 * İki görüntünün PSNR'ı (dB, yüksek = benzer; aynıysa `inf` → Infinity).
 * Piksel kayması SSIM'den daha keskin ayırt edilir.
 * @param {string} a
 * @param {string} b
 * @returns {Promise<number>}
 */
export async function psnr(a, b) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-',
  ]);
  const match = /average:(inf|[\d.]+)/.exec(stderr);
  if (!match) throw new Error(`PSNR okunamadı: ${a} / ${b}`);
  return match[1] === 'inf' ? Infinity : Number(match[1]);
}

/**
 * Kayıpsız (ffv1/mkv) yuv420p test kaynağı — h264'ün kabul etmediği tek sayılı
 * boyutlar için.
 *
 * Tuzak: testsrc2 boyutu kendi içinde çifte yuvarlıyor (2945 → 2944) ve yuv420p
 * crop da öyle. Bu yüzden çift boyutta üretilip RGB'de kırpılır, sonra yuv420p'ye
 * çevrilir — ffprobe'da gerçekten 2945 görünür.
 *
 * @param {string} path .mkv
 * @param {{ width: number, height: number, frames?: number, fps?: number }} o
 */
export async function makeLosslessClip(path, { width, height, frames = 24, fps = 24 }) {
  const even = (n) => n + (n % 2);
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=s=${even(width)}x${even(height)}:r=${fps}`,
    '-vf', `format=rgb24,crop=${width}:${height}:0:0,format=yuv420p`,
    '-frames:v', String(frames), '-c:v', 'ffv1', '-y', path,
  ]);
  return path;
}

/**
 * Ses tıklarının başlangıç anları (sn): mono'ya indirilip 48 kHz float olarak
 * çözülür, eşiği aşan ilk örnek bir tıkın başı sayılır; aynı tıkın devamı
 * `minGapSeconds` içinde yok sayılır. Örnek düzeyinde (~0.02 ms) hassas.
 *
 * @param {string} path
 * @param {{ dir: { path: (f: string) => string }, threshold?: number, minGapSeconds?: number }} o
 * @returns {Promise<{ onsets: number[], seconds: number }>}
 */
export async function findOnsets(path, { dir, threshold = 0.1, minGapSeconds = 1 }) {
  const rate = 48000;
  const raw = dir.path(`onsets-${Math.random().toString(36).slice(2, 8)}.f32`);
  await ffmpeg(['-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-c:a', 'pcm_f32le', '-y', raw]);
  const buf = await readFile(raw);

  const onsets = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < buf.length / 4; i++) {
    if (Math.abs(buf.readFloatLE(i * 4)) <= threshold) continue;
    if (i - lastLoud > minGapSeconds * rate) onsets.push(i / rate);
    lastLoud = i;
  }
  return { onsets, seconds: buf.length / 4 / rate };
}

/**
 * Kanal başına RMS seviyesi (dB) ve baskın frekans (sıfır geçiş oranından, saf
 * sinüste doğru). İsteğe bağlı kesit.
 *
 * @param {string} path
 * @param {{ start?: number, duration?: number }} [segment]
 * @returns {Promise<Array<{ rmsDb: number, hz: number }>>}
 */
export async function channelStats(path, segment = {}) {
  const seek = [];
  if (segment.start !== undefined) seek.push('-ss', String(segment.start));
  if (segment.duration !== undefined) seek.push('-t', String(segment.duration));
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', ...seek, '-i', path, '-map', '0:a:0',
    '-af', 'aresample=48000,astats=measure_perchannel=RMS_level+Zero_crossings_rate:measure_overall=none',
    '-f', 'null', '-',
  ], { fullStderr: true });

  const rms = [...stderr.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/g)].map((m) => Number(m[1]));
  const zcr = [...stderr.matchAll(/Zero crossings rate:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return rms.map((rmsDb, i) => ({ rmsDb, hz: (zcr[i] * 48000) / 2 }));
}

/**
 * Video akışındaki kare (paket) sayısı.
 * @param {string} path
 */
export async function countFrames(path) {
  const { stdout } = await ffprobe([
    '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', path,
  ]);
  return Number(stdout.trim());
}

/**
 * Loop birleşme noktası ölçümü: son kare → ilk kare SSIM'i ile klibin kendi
 * içindeki ardışık kare SSIM'lerini karşılaştırır.
 *
 * @param {string} path
 * @param {{ frames: number, dir: { path: (f: string) => string }, samples?: number[] }} o
 *   samples: ardışık çift başlangıçları (varsayılan: klibe yayılmış 6 nokta)
 * @returns {Promise<{ junction: number, consecutive: number[], minConsecutive: number }>}
 */
export async function measureLoopJunction(path, { frames, dir, samples }) {
  const tag = Math.random().toString(36).slice(2, 8);
  const at = async (i) => extractFrame(path, i, dir.path(`${tag}-${i}.png`));

  const junction = await ssim(await at(frames - 1), await at(0));

  const starts = samples ?? [0, 0.2, 0.4, 0.6, 0.8, 0.95].map((r) => Math.min(frames - 2, Math.floor(r * frames)));
  const consecutive = [];
  for (const i of starts) consecutive.push(await ssim(await at(i), await at(i + 1)));

  return { junction, consecutive, minConsecutive: Math.min(...consecutive) };
}
