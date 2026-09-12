/**
 * Aşama 4a — Video hazırlığı.
 *
 * Ham klip → base.mp4: watermark kırpılır, ses atılır, loop kontrol edilir.
 *
 * Girdi 5 saniyelik bir klip; buradaki her işlem saniyeler sürer. Pahalı olan
 * kısım 04-assemble.js'teki 48 dakikalık encode — bu yüzden kırpma değeri
 * ORADAN ÖNCE doğrulanır.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { probe } from '../core/probe.js';

const DEFAULTS = {
  crf: 16,
  preset: 'slow',
  /** Loop testinde kaç tekrar üretilsin (gözle bakmak için). */
  loopTestRepeats: 2,
  /**
   * Loop birleşme noktasını yumuşatan crossfade (sn). 0 = kapalı.
   *
   * SINANMAMIŞ: Hailuo klibinin loop'u şans eseri temiz çıktığı için bu dal
   * hiç çalışmadı. Aşama 6'da yapay veriyle sınanacak (HANDOFF bölüm 13).
   */
  crossfadeSeconds: 0,
};

const NOOP_LOGGER = { info() {}, warn() {} };

export class CropNotConfirmedError extends Error {
  /** @param {string} framePath */
  constructor(framePath) {
    super(
      'Kırpma onaylanmadı. Kontrol karesine bak ve onayla, ya da cropBottom ' +
      `değerini konfige yaz: ${framePath}`,
    );
    this.name = 'CropNotConfirmedError';
    this.framePath = framePath;
  }
}

/**
 * Ham klipten base.mp4 üretir.
 *
 * @param {object} options
 * @param {string} options.clipPath ham klip (watermark'lı, sesli)
 * @param {string} options.outputPath üretilecek base.mp4
 * @param {object} options.workspace core/workspace.js örneği
 * @param {number} options.cropBottom alttan kırpılacak piksel
 * @param {boolean} [options.cropFromConfig] cropBottom konfigden mi geldi
 * @param {boolean} [options.verifyCrop] true ise konfigde değer olsa da onay iste
 * @param {boolean} [options.assumeApproved] onayı atla (testler ve otomasyon)
 * @param {(info: { framePath: string, cropBottom: number, before: object, after: object })
 *   => Promise<boolean>} [options.confirm] onay callback'i
 * @param {number} [options.scaleWidth] verilirse bu genişliğe ölçekler
 * @param {number} [options.crf]
 * @param {string} [options.preset]
 * @param {number} [options.crossfadeSeconds]
 * @param {boolean} [options.loopTest] gözle bakılacak tekrarlı dosya üret
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function prepareVideo(options) {
  const {
    clipPath,
    outputPath,
    workspace,
    cropBottom,
    cropFromConfig = false,
    verifyCrop = false,
    assumeApproved = false,
    confirm,
    scaleWidth,
    crf = DEFAULTS.crf,
    preset = DEFAULTS.preset,
    crossfadeSeconds = DEFAULTS.crossfadeSeconds,
    loopTest = true,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  const source = await probe(clipPath);
  if (!source.hasVideo) {
    throw new Error(`Video akışı yok: ${clipPath}`);
  }

  const croppedHeight = source.height - cropBottom;
  if (croppedHeight <= 0) {
    throw new Error(
      `cropBottom (${cropBottom}) klip yüksekliğinden (${source.height}) büyük.`,
    );
  }

  // 1 — Kırpma onayı (koşullu, HANDOFF bölüm 14/1)
  const approval = await resolveCropApproval({
    clipPath, cropBottom, croppedHeight, source,
    workspace, cropFromConfig, verifyCrop, assumeApproved, confirm, logger,
  });

  // 2 — Kırp, sesi at, gerekirse ölçekle
  await mkdir(dirname(outputPath), { recursive: true });

  const filters = [`crop=iw:ih-${cropBottom}:0:0`];
  if (scaleWidth) {
    // -2: yüksekliği en-boy oranına göre çift sayıya yuvarla (h264 şartı).
    filters.push(`scale=${scaleWidth}:-2`);
  }
  if (crossfadeSeconds > 0) {
    warn(
      `Loop crossfade açık (${crossfadeSeconds} sn) — bu dal henüz gerçek ` +
      'veriyle sınanmadı, çıktıyı gözle kontrol et.',
    );
  }

  logger.info(
    `Kırpılıyor: ${source.width}×${source.height} → ${source.width}×${croppedHeight}` +
    (scaleWidth ? `, ${scaleWidth} px genişliğe ölçekleniyor` : ''),
  );

  await ffmpeg([
    '-i', clipPath,
    ...(crossfadeSeconds > 0
      ? ['-filter_complex', buildCrossfadeFilter(source, filters, crossfadeSeconds)]
      : ['-vf', filters.join(',')]),
    '-an',                       // Hailuo'nun 32 kHz sesi kullanılmıyor
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', preset,
    '-y', outputPath,
  ], { onProgress });

  const result = await probe(outputPath);

  if (result.hasAudio) {
    warn('base.mp4 hâlâ ses akışı taşıyor — -an beklendiği gibi çalışmamış.');
  }
  if (result.height !== croppedHeight && !scaleWidth) {
    throw new Error(
      `Kırpma tutmadı: ${result.height} px, beklenen ${croppedHeight} px.`,
    );
  }

  // 3 — Loop kontrolü
  const loop = await inspectLoop({ path: outputPath, workspace, loopTest, logger });

  return {
    output: outputPath,
    source: {
      path: clipPath,
      width: source.width,
      height: source.height,
      duration: source.duration,
      hadAudio: source.hasAudio,
    },
    crop: { bottom: cropBottom, approval },
    scale: scaleWidth ? { width: scaleWidth, height: result.height } : null,
    result: {
      width: result.width,
      height: result.height,
      duration: result.duration,
      fps: result.fps,
      codec: result.videoCodec,
      size: result.size,
      hasAudio: result.hasAudio,
    },
    loop,
    crossfadeSeconds,
    warnings,
  };
}

/**
 * Kırpma onayının gerekip gerekmediğine karar verir ve gerekiyorsa alır.
 *
 * Aynı araçla üretilen kliplerde watermark hep aynı yerde: değer bir kez
 * konfige yazıldıktan sonra her videoda tekrar sormanın anlamı yok.
 *
 * @returns {Promise<{ required: boolean, granted: boolean, reason: string, framePath: string|null }>}
 */
async function resolveCropApproval(params) {
  const {
    clipPath, cropBottom, croppedHeight, source, workspace,
    cropFromConfig, verifyCrop, assumeApproved, confirm, logger,
  } = params;

  const required = verifyCrop || !cropFromConfig;

  if (!required) {
    logger.info(`cropBottom=${cropBottom} konfigden geldi, onay sorulmuyor.`);
    return { required: false, granted: true, reason: 'config', framePath: null };
  }

  // Kontrol karesi her koşulda üretilir — atlanmış olsa bile bakılabilsin.
  const framePath = workspace.path('crop-check.png');
  await ffmpeg([
    '-i', clipPath,
    '-vf', `crop=iw:ih-${cropBottom}:0:0`,
    // Tek kare yazarken ffmpeg dosya adını sekans kalıbı sanıyor (tuzak #5).
    '-frames:v', '1', '-update', '1',
    '-y', framePath,
  ]);

  const reason = verifyCrop ? 'verify-crop' : 'config-yok';

  if (assumeApproved) {
    logger.info(`Onay atlandı (assumeApproved), kontrol karesi: ${framePath}`);
    return { required: true, granted: true, reason: `${reason}/assumeApproved`, framePath };
  }

  if (typeof confirm !== 'function') {
    throw new CropNotConfirmedError(framePath);
  }

  const granted = await confirm({
    framePath,
    cropBottom,
    before: { width: source.width, height: source.height },
    after: { width: source.width, height: croppedHeight },
  });

  if (!granted) throw new CropNotConfirmedError(framePath);

  return { required: true, granted: true, reason, framePath };
}

/**
 * Loop'un kapanıp kapanmadığına dair iki çıktı üretir:
 *   - SSIM: ilk kare ile son kare arasındaki benzerlik (ÖLÇÜM, kapı değil)
 *   - Tekrarlı dosya: gözle bakmak için
 *
 * SSIM eşiği bilinçli olarak YOK. Elde tek bir başarılı örnek var; "temiz
 * loop"un hangi değere denk geldiği bilinmiyor. Uydurma eşik yanlış güven
 * verir — sayı raporlanır, kararı insan verir (HANDOFF bölüm 13).
 */
async function inspectLoop({ path, workspace, loopTest, logger }) {
  const info = await probe(path);
  const lastFrameTime = Math.max(0, info.duration - 1 / (info.fps || 24));

  const firstFrame = workspace.path('loop-first.png');
  const lastFrame = workspace.path('loop-last.png');

  await ffmpeg(['-i', path, '-frames:v', '1', '-update', '1', '-y', firstFrame]);
  await ffmpeg([
    '-ss', String(lastFrameTime), '-i', path,
    '-frames:v', '1', '-update', '1', '-y', lastFrame,
  ]);

  const ssim = await measureSsim(firstFrame, lastFrame);
  logger.info(`Loop birleşme noktası SSIM: ${ssim ?? 'ölçülemedi'} (bilgi amaçlı)`);

  let testPath = null;
  if (loopTest) {
    testPath = workspace.path('loop-test.mp4');
    await ffmpeg([
      '-stream_loop', String(DEFAULTS.loopTestRepeats),
      '-i', path,
      '-c', 'copy',
      '-y', testPath,
    ]);
    logger.info(`Loop testi üretildi (${DEFAULTS.loopTestRepeats + 1} tekrar): ${testPath}`);
  }

  return {
    ssim,
    ssimIsGate: false,
    firstFrame,
    lastFrame,
    testFile: testPath,
    repeats: loopTest ? DEFAULTS.loopTestRepeats + 1 : 0,
  };
}

/**
 * İki görüntü arasındaki SSIM (1.0 = birebir aynı).
 * Ölçülemezse null döner — bu bir kapı değil, rapor satırı.
 *
 * @param {string} a @param {string} b
 * @returns {Promise<number|null>}
 */
async function measureSsim(a, b) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info',
    '-i', a, '-i', b,
    '-lavfi', 'ssim',
    '-f', 'null', '-',
  ]);

  const match = /All:\s*([\d.]+)/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/**
 * Loop'u kapatmak için sonu başına karıştıran filtre zinciri.
 *
 * SINANMAMIŞ DAL — HANDOFF bölüm 13'teki listede. Klibin sonundaki
 * `crossfadeSeconds` saniye, başındaki aynı süreyle çapraz geçişle birleşir;
 * çıktı o kadar kısalır.
 *
 * @param {{ duration: number }} source
 * @param {string[]} filters kırpma/ölçekleme zinciri
 * @param {number} crossfadeSeconds
 * @returns {string}
 */
function buildCrossfadeFilter(source, filters, crossfadeSeconds) {
  const chain = filters.join(',');
  const offset = source.duration - crossfadeSeconds;

  return (
    `[0:v]${chain},split[body][tail];` +
    `[body]trim=0:${offset},setpts=PTS-STARTPTS[main];` +
    `[tail]trim=${offset},setpts=PTS-STARTPTS[fade];` +
    `[main][fade]xfade=transition=fade:duration=${crossfadeSeconds}:offset=${offset - crossfadeSeconds}`
  );
}
