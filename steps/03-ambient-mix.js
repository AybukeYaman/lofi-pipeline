/**
 * Aşama 3 — Ambient karıştırma.
 *
 * Videonun mevcut müziğinin üzerine ortam sesini (şömine çıtırtısı) ekler.
 *
 * Bölüm 7'deki elle iterasyonun (I=-26 → -28 → -29 → -30, 6 deneme) yerine:
 * müziği ölç, hedefi farktan hesapla, kısa örnekle doğrula, sonra üret.
 * Mutlak bir I değeri hiçbir yere yazılmaz.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import {
  loudnessMatches,
  loudnormFilter,
  measureLoudness,
  measureVolume,
  targetLoudnessFor,
} from '../core/loudness.js';
import { durationsMatch, probe } from '../core/probe.js';

/**
 * Varsayılanlar.
 *
 * `ambientOffsetDb` ULAŞILAN seviyeler arasındaki fark, filtreye yazılan
 * parametre farkı değil. Yayınlanan videoda müzik -14.78 LUFS, ambient'in
 * gerçekte ulaştığı seviye -33.61 LUFS → fark -18.8 LU.
 *
 * Elle bulunan "I=-30" bu sayı DEĞİLDİR: o, tek geçişli loudnorm'a verilen
 * parametreydi ve tek geçiş hedefi ıskaladığı için ulaşılan seviye -33.6 oldu.
 * İkisini karıştırmamak için burada iki geçişli loudnorm kullanılıyor —
 * o modda hedef ile ulaşılan seviye aynı şey.
 */
const DEFAULTS = {
  ambientOffsetDb: -18.8,
  fadeOut: 5,
  bitrate: '192k',
  truePeak: -6,
  loudnessRange: 7,
  /** Doğrulama örneğinin alınacağı yer — videonun ortalarından kısa bir kesit. */
  sample: { startSeconds: 600, duration: 30 },
};

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Ambient sesi videonun ses akışına karıştırır.
 *
 * @param {object} options
 * @param {string} options.videoPath müziği hazır video (ambient'siz)
 * @param {string} options.ambientPath ortam sesi
 * @param {string} options.outputPath
 * @param {object} options.workspace core/workspace.js örneği (doğrulama örnekleri için)
 * @param {number} [options.ambientOffsetDb] ambient müziğin kaç LU altında kalsın
 * @param {number} [options.fadeOut] sondaki fade süresi (sn)
 * @param {string} [options.bitrate]
 * @param {{ startSeconds: number, duration: number }|null} [options.sample]
 *   null verilirse doğrulama atlanır (hızlı ama körlemesine)
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function mixAmbient(options) {
  const {
    videoPath,
    ambientPath,
    outputPath,
    workspace,
    ambientOffsetDb = DEFAULTS.ambientOffsetDb,
    fadeOut = DEFAULTS.fadeOut,
    bitrate = DEFAULTS.bitrate,
    sample = DEFAULTS.sample,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  // 1 — Girdileri tanı
  const video = await probe(videoPath);
  const ambient = await probe(ambientPath);

  if (!video.hasAudio) {
    throw new Error(`Videoda ses akışı yok, karıştıracak müzik bulunamadı: ${videoPath}`);
  }
  if (!ambient.hasAudio) {
    throw new Error(`Ambient dosyasında ses akışı yok: ${ambientPath}`);
  }

  // Hedef sample rate videodan okunur, sabit yazılmaz.
  // Ambient 44.1 kHz, müzik 48 kHz — eşitlenmezse pitch kayması olur (bölüm 7).
  const sampleRate = video.sampleRate;
  if (ambient.sampleRate !== sampleRate) {
    logger.info(
      `Ambient ${ambient.sampleRate} Hz, hedef ${sampleRate} Hz — aresample uygulanacak.`,
    );
  }

  // 2 — Müziği ölç, hedefi türet
  const sampleWindow = sample ? fitSample(sample, video.duration) : null;
  if (sampleWindow && sampleWindow.startSeconds !== sample.startSeconds) {
    logger.info(
      `Video ${video.duration} sn — doğrulama kesiti ${sample.startSeconds}. sn'ye sığmıyor, ` +
      `${sampleWindow.startSeconds}. sn'den ${sampleWindow.duration} sn alınıyor.`,
    );
  }
  const measureSegment = sampleWindow ?? {};
  const music = await measureLoudness(videoPath, measureSegment);
  const targetI = targetLoudnessFor(music.inputI, ambientOffsetDb);

  // Ambient'in kendi seviyesi: iki geçişli loudnorm'un birinci geçişi.
  const ambientMeasured = await measureLoudness(ambientPath);
  const ambientVolume = await measureVolume(ambientPath);
  if (ambientVolume.maxVolume >= -0.1) {
    logger.info(
      `Ambient tepe seviyesi ${ambientVolume.maxVolume} dB — düz çarpan clipping ` +
      'yapardı, loudnorm kullanılıyor.',
    );
  }

  logger.info(
    `Müzik ${music.inputI} LUFS, ofset ${ambientOffsetDb} LU → ambient hedefi I=${targetI}`,
  );

  const ambientFilter = buildAmbientFilter({
    sampleRate,
    targetI,
    truePeak: DEFAULTS.truePeak,
    loudnessRange: DEFAULTS.loudnessRange,
    measured: ambientMeasured,
  });

  // 3 — Kısa örneklerle doğrula (48 dakikayı üretmeden önce)
  const verification = sampleWindow
    ? await verifyLevels({
      videoPath,
      ambientPath,
      workspace,
      ambientFilter,
      sample: sampleWindow,
      targetI,
      musicI: music.inputI,
      logger,
      warn,
    })
    : null;

  if (verification === null) {
    warn('Doğrulama örneği atlandı (sample: null) — seviye körlemesine uygulanıyor.');
  }

  // 4 — Nihai çıktı
  await mkdir(dirname(outputPath), { recursive: true });

  const fadeStart = Math.max(0, video.duration - fadeOut);
  const filterComplex =
    `[1:a]${ambientFilter},afade=t=out:st=${fadeStart}:d=${fadeOut}[amb];` +
    `[0:a][amb]${AMIX}[out]`;

  logger.info('Nihai karıştırma başlıyor (video yeniden encode edilmiyor).');

  await ffmpeg([
    '-i', videoPath,
    '-stream_loop', '-1', '-i', ambientPath,
    '-filter_complex', filterComplex,
    '-map', '0:v',
    '-map', '[out]',
    // Video kopyalanıyor: yeniden encode 17 dakika sürerdi, kopya 1-2 dakika.
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', bitrate,
    '-y', outputPath,
  ], { onProgress });

  // 5 — Çıktıyı doğrula
  const result = await probe(outputPath);

  if (!durationsMatch(result.duration, video.duration)) {
    throw new Error(
      `Çıktı süresi girdiden farklı: ${result.duration} sn / ${video.duration} sn.`,
    );
  }
  if (result.videoCodec !== video.videoCodec || result.width !== video.width) {
    throw new Error(
      'Video akışı değişmiş — kopyalanması gerekirken yeniden encode edilmiş olabilir.',
    );
  }

  return {
    output: outputPath,
    duration: result.duration,
    ambientOffsetDb,
    musicI: music.inputI,
    ambientTargetI: targetI,
    ambient: {
      source: ambientPath,
      sampleRate: ambient.sampleRate,
      resampledTo: ambient.sampleRate === sampleRate ? null : sampleRate,
      sourceI: ambientMeasured.inputI,
      maxVolume: ambientVolume.maxVolume,
      loudnormPasses: 2,
    },
    video: { codec: result.videoCodec, copied: true, width: result.width, height: result.height },
    audio: { codec: result.audioCodec, sampleRate: result.sampleRate, bitrate },
    fade: { start: fadeStart, duration: fadeOut },
    verification,
    warnings,
  };
}

/**
 * Doğrulama kesitini videoya sığdırır. Kesit videonun sonunu aşıyorsa (kısa
 * video) ölçülecek ses kalmaz ve loudnorm NaN döndürür; bu durumda kesit
 * videonun ortasına alınır, süre de gerekirse videoya indirilir.
 *
 * @param {{ startSeconds: number, duration: number }} sample
 * @param {number} videoDuration
 * @returns {{ startSeconds: number, duration: number }}
 */
export function fitSample(sample, videoDuration) {
  if (sample.startSeconds + sample.duration <= videoDuration) return sample;
  const duration = Math.min(sample.duration, videoDuration);
  const startSeconds = Number(Math.max(0, (videoDuration - duration) / 2).toFixed(3));
  return { startSeconds, duration };
}

/**
 * amix ayarları.
 *
 * `weights=1 1:normalize=0` olmadan amix girdilerin seviyesini kendiliğinden
 * düşürüyor; bölüm 7'de bu "sanki bütün ses artıyor gibi" olarak fark edildi.
 * duration=first → çıktı videonun süresi kadar, ambient loop'u onu uzatmıyor.
 */
const AMIX = 'amix=inputs=2:duration=first:weights=1 1:normalize=0';

/**
 * Ambient dalının filtre zinciri (fade hariç — o süreye bağlı, ayrı ekleniyor).
 *
 * aresample önce gelir: ambient 44.1 kHz, müzik 48 kHz. Eşitlenmezse pitch
 * kayması olur (bölüm 7).
 *
 * @param {{
 *   sampleRate: number, targetI: number, truePeak: number,
 *   loudnessRange: number, measured?: object,
 * }} p
 * @returns {string}
 */
function buildAmbientFilter({ sampleRate, targetI, truePeak, loudnessRange, measured }) {
  const loudnorm = loudnormFilter({ targetI, truePeak, loudnessRange, measured });
  return `aresample=${sampleRate},${loudnorm}`;
}

/**
 * Kısa örneklerle iki şeyi doğrular:
 *   1. Ambient gerçekten hedef seviyeye indi mi (loudnorm tuttu mu).
 *   2. amix müziğin seviyesini düşürdü mü (normalize=0 çalışıyor mu).
 *
 * Örnekler PCM olarak üretiliyor — encoder renklendirmesi ölçümü kirletmesin.
 * 48 dakika yerine 30 saniye işleniyor, döngü saniyeler sürüyor.
 */
async function verifyLevels(params) {
  const {
    videoPath, ambientPath, workspace, ambientFilter,
    sample, targetI, musicI, logger, warn,
  } = params;

  const seek = ['-ss', String(sample.startSeconds), '-t', String(sample.duration)];

  // 1 — Ambient tek başına, normalize edilmiş hali
  const ambientSample = workspace.path('verify-ambient.wav');
  await ffmpeg([
    '-stream_loop', '-1', ...seek, '-i', ambientPath,
    '-af', ambientFilter,
    '-c:a', 'pcm_s16le',
    '-y', ambientSample,
  ]);
  const ambientMeasured = await measureLoudness(ambientSample);

  // 2 — Karışımın kendisi
  const mixSample = workspace.path('verify-mix.wav');
  await ffmpeg([
    ...seek, '-i', videoPath,
    '-stream_loop', '-1', ...seek, '-i', ambientPath,
    '-filter_complex', `[1:a]${ambientFilter}[amb];[0:a][amb]${AMIX}[out]`,
    '-map', '[out]',
    '-c:a', 'pcm_s16le',
    '-y', mixSample,
  ]);
  const mixMeasured = await measureLoudness(mixSample);

  const ambientOnTarget = loudnessMatches(ambientMeasured.inputI, targetI);
  // Karışım müzikten daha sessiz çıkıyorsa amix seviyeyi kısıyor demektir.
  const musicPreserved = mixMeasured.inputI >= musicI - 1;

  logger.info(
    `Doğrulama: ambient ${ambientMeasured.inputI} LUFS (hedef ${targetI}), ` +
    `karışım ${mixMeasured.inputI} LUFS (müzik ${musicI})`,
  );

  if (!ambientOnTarget) {
    warn(
      `Ambient hedefi tutturamadı: ${ambientMeasured.inputI} LUFS, hedef ${targetI} LUFS.`,
    );
  }
  if (!musicPreserved) {
    warn(
      `Karışım müzikten sessiz çıktı (${mixMeasured.inputI} < ${musicI} LUFS) — ` +
      'amix seviyeyi kısıyor olabilir, weights/normalize ayarını kontrol et.',
    );
  }

  return {
    sample,
    ambientMeasuredI: ambientMeasured.inputI,
    ambientTargetI: targetI,
    ambientOnTarget,
    mixI: mixMeasured.inputI,
    musicI,
    musicPreserved,
  };
}
