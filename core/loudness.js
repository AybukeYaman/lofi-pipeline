/**
 * Ses seviyesi ölçümü.
 *
 * Tek sorumluluk: bir dosyanın ne kadar yüksek olduğunu sayıyla söylemek ve
 * hedef seviyeyi hesaplamak. Karıştırma, filtre kurma, dosya üretme işi değil —
 * onlar steps/03-ambient-mix.js'in.
 *
 * Neden loudnorm ölçümü: uygulanacak filtre loudnorm olduğu için ölçüm ile
 * hedef aynı birimde (LUFS) olmalı. volumedetect'in verdiği mean/max dBFS
 * farklı bir birim; ikisini karıştırmak bölüm 7'deki 6 denemelik iterasyonun
 * sebebi. volumedetect burada yalnızca tepe/clipping kontrolü için var.
 */

import { ffmpeg } from './ffmpeg.js';

/**
 * Doğrulamada kabul edilen sapma (LU).
 * loudnorm tek geçişte hedefi bu mertebede tutturur; daha darı yanlış alarm üretir.
 */
export const LOUDNESS_TOLERANCE = 1.0;

/** Ölçüm sırasında loudnorm'a verilen hedefler. Ölçülen değerleri etkilemez. */
const MEASURE_TARGET = { I: -24, TP: -2, LRA: 7 };

/**
 * Ölçüm çağrılarında log seviyesi: loudnorm ve volumedetect sonuçlarını
 * `info` seviyesinde basıyor, sarmalayıcının varsayılan `error` seviyesinde
 * çıktı hiç görünmez.
 */
const MEASURE_LOGLEVEL = ['-loglevel', 'info'];

export class LoudnessError extends Error {
  /** @param {string} message @param {{ path: string, stderr?: string }} detail */
  constructor(message, detail) {
    super(message);
    this.name = 'LoudnessError';
    this.path = detail.path;
    this.stderr = detail.stderr;
  }
}

/**
 * Ölçülecek bölümü sınırlayan argümanlar.
 * 48 dakikalık dosyanın tamamını çözmek yerine bir kesit ölçmek,
 * doğrulama döngüsünü dakikalardan saniyelere indiriyor.
 *
 * @param {{ startSeconds?: number, duration?: number }} segment
 * @returns {string[]}
 */
function segmentArgs(segment = {}) {
  const args = [];
  if (segment.startSeconds !== undefined) args.push('-ss', String(segment.startSeconds));
  if (segment.duration !== undefined) args.push('-t', String(segment.duration));
  return args;
}

/**
 * loudnorm birinci geçişi — dosyanın algısal yüksekliğini LUFS olarak ölçer.
 *
 * @param {string} path
 * @param {{ startSeconds?: number, duration?: number }} [segment]
 * @returns {Promise<{
 *   inputI: number, inputTp: number, inputLra: number,
 *   inputThresh: number, targetOffset: number,
 * }>}
 */
export async function measureLoudness(path, segment = {}) {
  const filter =
    `loudnorm=I=${MEASURE_TARGET.I}:TP=${MEASURE_TARGET.TP}` +
    `:LRA=${MEASURE_TARGET.LRA}:print_format=json`;

  const { stderr } = await ffmpeg([
    ...MEASURE_LOGLEVEL,
    ...segmentArgs(segment),
    '-i', path,
    '-af', filter,
    '-f', 'null', '-',
  ]);

  const report = extractJson(stderr);
  if (report === null) {
    throw new LoudnessError(`loudnorm ölçümü okunamadı: ${path}`, { path, stderr });
  }

  return {
    inputI: Number(report.input_i),
    inputTp: Number(report.input_tp),
    inputLra: Number(report.input_lra),
    inputThresh: Number(report.input_thresh),
    targetOffset: Number(report.target_offset),
  };
}

/**
 * volumedetect — ortalama ve tepe seviyesi (dBFS).
 *
 * `maxVolume` 0.0 dB ise düz bir `volume` çarpanı clipping yapar; bölüm 7'de
 * ambient tam olarak böyleydi. Bu yüzden çarpan değil loudnorm kullanılıyor.
 *
 * @param {string} path
 * @param {{ startSeconds?: number, duration?: number }} [segment]
 * @returns {Promise<{ meanVolume: number, maxVolume: number }>}
 */
export async function measureVolume(path, segment = {}) {
  const { stderr } = await ffmpeg([
    ...MEASURE_LOGLEVEL,
    ...segmentArgs(segment),
    '-i', path,
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ]);

  const meanVolume = extractDb(stderr, 'mean_volume');
  const maxVolume = extractDb(stderr, 'max_volume');

  if (meanVolume === null || maxVolume === null) {
    throw new LoudnessError(`volumedetect ölçümü okunamadı: ${path}`, { path, stderr });
  }

  return { meanVolume, maxVolume };
}

/**
 * Hedef seviyeyi referansa göre hesaplar.
 *
 * Mutlak bir sabit (ör. I=-30) yazılmaz: bir sonraki albümün müziği daha
 * sessizse ambient de onunla birlikte iner. Sabit olan şey İKİSİ ARASINDAKİ
 * FARK.
 *
 * @param {number} referenceI referans parçanın ölçülen LUFS değeri
 * @param {number} offsetDb referansın kaç LU altına inileceği (negatif)
 * @returns {number} hedef LUFS
 */
export function targetLoudnessFor(referenceI, offsetDb) {
  if (!Number.isFinite(referenceI)) {
    throw new LoudnessError('Referans seviye ölçülemedi.', { path: '' });
  }
  return Number((referenceI + offsetDb).toFixed(1));
}

/**
 * loudnorm filtre ifadesini kurar.
 *
 * `measured` verilirse İKİ GEÇİŞLİ (linear) mod: ölçülen değerler filtreye
 * parametre olarak geçer ve hedef gerçekten tutturulur. Verilmezse tek geçişli
 * dinamik mod çalışır — o mod hedefi 2-4 LU ıskalıyor, yani filtreye yazılan I
 * ulaşılan seviye DEĞİLDİR. Bu ayrım bu projede iki kez yanlış hesaba yol açtı;
 * ölçüm elde varken her zaman iki geçiş kullanılmalı.
 *
 * @param {object} params
 * @param {number} params.targetI hedef LUFS
 * @param {number} params.truePeak
 * @param {number} params.loudnessRange
 * @param {Awaited<ReturnType<typeof measureLoudness>>} [params.measured]
 * @returns {string}
 */
export function loudnormFilter({ targetI, truePeak, loudnessRange, measured }) {
  const parts = [`I=${targetI}`, `TP=${truePeak}`, `LRA=${loudnessRange}`];

  if (measured) {
    parts.push(
      `measured_I=${measured.inputI}`,
      `measured_TP=${measured.inputTp}`,
      `measured_LRA=${measured.inputLra}`,
      `measured_thresh=${measured.inputThresh}`,
      `offset=${measured.targetOffset}`,
      'linear=true',
    );
  }

  return `loudnorm=${parts.join(':')}`;
}

/**
 * İki seviyenin tolerans içinde eşit sayılıp sayılmayacağı.
 * @param {number} a @param {number} b @param {number} [tolerance]
 */
export function loudnessMatches(a, b, tolerance = LOUDNESS_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= tolerance;
}

/**
 * stderr'deki son JSON bloğunu ayrıştırır.
 * loudnorm raporu çıktının sonunda, süslü parantezler arasında basılıyor.
 *
 * @param {string} stderr
 * @returns {Record<string, string>|null}
 */
function extractJson(stderr) {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    return JSON.parse(stderr.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * `mean_volume: -17.5 dB` biçimindeki satırdan sayıyı çeker.
 *
 * @param {string} stderr
 * @param {string} key
 * @returns {number|null}
 */
function extractDb(stderr, key) {
  const match = new RegExp(`${key}:\\s*(-?\\d+(?:\\.\\d+)?) dB`).exec(stderr);
  return match ? Number(match[1]) : null;
}
