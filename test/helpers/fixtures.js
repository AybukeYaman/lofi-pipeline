/**
 * Test yardımcıları — yapay medya üretimi ve kare düzeyinde ölçüm.
 *
 * Gerçek albüme bağımlı değil: her fixture lavfi kaynaklarından saniyeler içinde
 * geçici klasörde üretilir. Ölçümler (SSIM, kare sayısı) testlerin "çalıştı"
 * yerine "doğru çalıştı" diyebilmesi için.
 */

import { mkdtemp, rm } from 'node:fs/promises';
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
 * Sabit frekanslı stereo AAC ses.
 * @param {string} path
 * @param {{ seconds: number, frequency?: number, sampleRate?: number }} o
 */
export async function makeTone(path, { seconds, frequency = 440, sampleRate = 48000 }) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `sine=f=${frequency}:d=${seconds}:sample_rate=${sampleRate}`,
    '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
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
