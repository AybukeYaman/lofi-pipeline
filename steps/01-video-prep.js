/**
 * Aşama 4a — Video hazırlığı.
 *
 * Ham klip → base.mp4: watermark kırpılır, en-boy oranına (varsayılan 16:9)
 * kırpılır, ses atılır, loop kontrol edilir. İki kırpma tek filtre zincirinde,
 * tek encode'da uygulanır.
 *
 * Girdi 5 saniyelik bir klip; buradaki her işlem saniyeler sürer. Pahalı olan
 * kısım 04-assemble.js'teki 48 dakikalık encode — bu yüzden kırpma değeri
 * ORADAN ÖNCE doğrulanır.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { AspectError, parseAspect } from '../core/aspect.js';
import { ffmpeg } from '../core/ffmpeg.js';
import { probe } from '../core/probe.js';

// Adımı kullananlar hata tipini buradan da alabilsin.
export { AspectError, parseAspect };

const DEFAULTS = {
  /** Nihai çıktı her videoda 16:9 isteniyor (kırpma modu). */
  aspect: '16:9',
  crf: 16,
  preset: 'slow',
  /** Loop testinde kaç tekrar üretilsin (gözle bakmak için). */
  loopTestRepeats: 2,
  /**
   * Loop birleşme noktasını kapatan crossfade (sn). 0 = kapalı.
   * Hailuo klibinin loop'u temiz çıktığı için varsayılan kapalı; kapanmayan
   * klipte project.json → video.crossfadeSeconds ile açılır.
   */
  crossfadeSeconds: 0,
};

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Klip video değil: süresi olmayan tek kare (uzantısı .mp4 yapılmış görsel).
 * Ayrı tür, çünkü çözümü kullanıcıda: başka bir klip seçmesi gerekiyor.
 */
export class ClipNotVideoError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClipNotVideoError';
  }
}

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

export class CropSizeError extends Error {
  /**
   * @param {string} message
   * @param {{ cropBottom: number, suggestions: number[] }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = 'CropSizeError';
    this.cropBottom = detail.cropBottom;
    this.suggestions = detail.suggestions;
  }
}

/**
 * Kırpma sonrası boyutların h264/yuv420p'ye uyduğunu denetler.
 *
 * yuv420p tek sayılı boyutu taşıyamaz ve ffmpeg crop filtresi HATA VERMEZ —
 * boyutu sessizce bir aşağı yuvarlar (ölçüldü: ih−151 → 1096, 1097 değil). Yani
 * kullanıcının verdiği 151 fiilen 152 olurdu. Değer değiştirilmez; komşu geçerli
 * değerler önerilip durulur (HANDOFF bölüm 15, Aşama 6 karar 1).
 *
 * Konfig doğrulamasında değil burada: yükseklik ancak klip ölçülünce bilinir.
 * prepareVideo bunu onaydan ve encode'dan önce çağırır.
 *
 * @param {{ height: number, cropBottom: number }} p height: ham klip
 */
export function checkCropHeight({ height, cropBottom = 0, cropTop = 0 }) {
  const croppedHeight = height - (cropBottom + cropTop);

  if (croppedHeight % 2 !== 0) {
    const suggestions = [cropBottom - 1, cropBottom + 1]
      .filter((v) => v >= 0 && height - (v + cropTop) > 0);
    throw new CropSizeError(
      `cropBottom ${cropBottom} kırpılmış yüksekliği tek sayı yapıyor (${height} − ${cropBottom + cropTop} = ` +
      `${croppedHeight}); h264/yuv420p çift sayı ister ve ffmpeg bunu sessizce bir piksel ` +
      `daha kırparak "düzeltirdi". Değer değiştirilmedi — ${suggestions.join(' ya da ')} kullan.`,
      { cropBottom, suggestions },
    );
  }
}

/**
 * Watermark kırpması SONRASI boyuttan en-boy kırpmasını hesaplar.
 *
 * Kırpma modu: kadrajın merkezi yerinde kalacak şekilde istenen orana
 * (varsayılan 16:9) kırpar. Geniş ya da dar her türlü oranda çift sayı
 * garanti edilir.
 *
 * @param {{ width: number, height: number, aspect: string }} p
 * @returns {{
 *   skipped: boolean, reason: string|null, aspect: string,
 *   before: { width: number, height: number },
 *   after: { width: number, height: number },
 *   left: number, right: number, top: number, bottom: number, filter: string|null,
 * }}
 */
export function planAspectCrop({ width, height, aspect }) {
  const ratio = parseAspect(aspect);
  const targetRatio = ratio.w / ratio.h;
  const currentRatio = width / height;
  const before = { width, height };

  const exactW = (height * ratio.w) / ratio.h;

  // Çift sayıya yuvarlama en fazla 1 px sapma getirir; o kadarı "zaten bu oranda".
  if (Math.abs(width - exactW) <= 1) {
    return {
      skipped: true, reason: `kaynak zaten ${ratio.label}`, aspect: ratio.label,
      before, after: before, left: 0, right: 0, top: 0, bottom: 0, filter: null,
    };
  }

  // 16:9'dan genişse: yanlardan eşit kes
  if (currentRatio >= targetRatio) {
    const targetHeight = 2 * Math.floor(height / 2);
    const exactTargetW = (targetHeight * ratio.w) / ratio.h;
    let targetWidth = 2 * Math.round(exactTargetW / 2);
    if (targetWidth > width) targetWidth = 2 * Math.floor(width / 2);
    const removed = width - targetWidth;
    const left = Math.floor(removed / 4) * 2;
    const right = removed - left;
    return {
      skipped: false,
      reason: null,
      aspect: ratio.label,
      before,
      after: { width: targetWidth, height: targetHeight },
      left,
      right,
      top: 0,
      bottom: 0,
      filter: `crop=${targetWidth}:${targetHeight}:${left}:0`,
    };
  } else {
    // 16:9'dan darsa (daha uzunsa): üstten ve alttan eşit keserek 16:9 kadraj oluştur
    const targetWidth = 2 * Math.floor(width / 2);
    const exactTargetH = (targetWidth * ratio.h) / ratio.w;
    let targetHeight = 2 * Math.round(exactTargetH / 2);
    if (targetHeight > height) targetHeight = 2 * Math.floor(height / 2);
    const removed = height - targetHeight;
    const top = Math.floor(removed / 4) * 2;
    const bottom = removed - top;
    return {
      skipped: false,
      reason: null,
      aspect: ratio.label,
      before,
      after: { width: targetWidth, height: targetHeight },
      left: 0,
      right: 0,
      top,
      bottom,
      filter: `crop=${targetWidth}:${targetHeight}:0:${top}`,
    };
  }
}

/**
 * Ham klipten base.mp4 üretir.
 *
 * @param {object} options
 * @param {string} options.clipPath ham klip (watermark'lı, sesli)
 * @param {string} options.outputPath üretilecek base.mp4
 * @param {object} options.workspace core/workspace.js örneği
 * @param {number} [options.cropBottom] alttan kırpılacak piksel
 * @param {number} [options.cropTop] üstten kırpılacak piksel
 * @param {number} [options.cropLeft] soldan kırpılacak piksel
 * @param {number} [options.cropRight] sağdan kırpılacak piksel
 * @param {boolean} [options.cropFromConfig] cropBottom konfigden mi geldi
 * @param {boolean} [options.verifyCrop] true ise konfigde değer olsa da onay iste
 * @param {boolean} [options.assumeApproved] onayı atla (testler ve otomasyon)
 * @param {(info: { framePath: string, cropBottom: number, before: object, after: object })
 *   => Promise<boolean>} [options.confirm] onay callback'i
 * @param {string|null} [options.aspect] watermark kırpmasından sonra bu orana
 *   kırpar (varsayılan '16:9'); null/false verilirse adım kapalı
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
    cropBottom = 0,
    cropTop = 0,
    cropLeft = 0,
    cropRight = 0,
    cropFromConfig = false,
    verifyCrop = false,
    assumeApproved = false,
    confirm,
    aspect = DEFAULTS.aspect,
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
  // Süresiz girdi = tek kare (uzantısı .mp4 yapılmış JPEG/PNG gibi). ffprobe
  // buna hasVideo=true der, prep de sorunsuz kodlar — hata ancak montajda
  // görülür: tek keyframe müzik boyunca on binlerce kez kopyalanır ve disk
  // kontrolü 40 dakikalık video için ~50 GB ister. Girişte kes.
  if (!(source.duration > 0)) {
    throw new ClipNotVideoError(
      `Klibin süresi yok (${source.formatName}/${source.videoCodec}, tek kare): ${clipPath}\n` +
      'Bu bir video değil — uzantısı .mp4 yapılmış bir görsel olabilir. ' +
      'videolar/ klasöründen gerçek bir video klip seç.',
    );
  }

  const topCrop = Number.isSafeInteger(cropTop) && cropTop > 0 ? cropTop : 0;
  const bottomCrop = Number.isSafeInteger(cropBottom) && cropBottom > 0 ? cropBottom : 0;
  const leftCrop = Number.isSafeInteger(cropLeft) && cropLeft > 0 ? cropLeft : 0;
  const rightCrop = Number.isSafeInteger(cropRight) && cropRight > 0 ? cropRight : 0;

  const croppedWidth = source.width - (leftCrop + rightCrop);
  const croppedHeight = source.height - (topCrop + bottomCrop);

  if (croppedWidth <= 0) {
    throw new Error(
      `Soldan ve sağdan kırpma (${leftCrop} + ${rightCrop} = ${leftCrop + rightCrop}) klip genişliğinden (${source.width}) büyük.`,
    );
  }
  if (croppedHeight <= 0) {
    throw new Error(
      `Üstten ve alttan kırpma (${topCrop} + ${bottomCrop} = ${topCrop + bottomCrop}) klip yüksekliğinden (${source.height}) büyük.`,
    );
  }
  // Onaydan ve encode'dan önce: tek sayılı yükseklik sessizce bir piksel daha kırpılırdı.
  checkCropHeight({ height: source.height, cropBottom: bottomCrop, cropTop: topCrop });

  // 1 — En-boy planı: watermark/kenar kırpması SONRASI boyuttan hesaplanır.
  const aspectPlan = aspect
    ? planAspectCrop({ width: croppedWidth, height: croppedHeight, aspect })
    : null;

  const filters = [];
  if (topCrop > 0 || bottomCrop > 0 || leftCrop > 0 || rightCrop > 0) {
    filters.push(`crop=${croppedWidth}:${croppedHeight}:${leftCrop}:${topCrop}`);
  }
  if (aspectPlan && !aspectPlan.skipped && aspectPlan.filter) {
    filters.push(aspectPlan.filter);
  }
  const expected = aspectPlan ? aspectPlan.after : { width: croppedWidth, height: croppedHeight };

  // Genişlik yalnızca en-boy adımı KIRPMADIĞINDA tek kalabilir (adım kapalı ya da
  // kaynak ±1 px ile zaten bu oranda). Kırpan plan her zaman çift genişlik verir.
  if (expected.width % 2 !== 0 && !scaleWidth) {
    throw new CropSizeError(
      `Çıktı genişliği tek sayı (${expected.width}): kaynak genişliği kırpılmadan kalıyor ve ` +
      'h264/yuv420p çift sayı ister — ffmpeg sessizce bir piksel kırpardı. ' +
      (aspect ? '' : 'En-boy adımını aç (--aspect 16:9) ya da ') + '--scale ile çift genişlik ver.',
      { cropBottom: bottomCrop, suggestions: [] },
    );
  }
  if (expected.height % 2 !== 0 && !scaleWidth) {
    expected.height = 2 * Math.floor(expected.height / 2);
  }

  if (aspectPlan?.skipped) {
    logger.info(`En-boy adımı atlandı: ${aspectPlan.reason} (${source.width}×${croppedHeight}).`);
  } else if (aspectPlan) {
    logger.info(
      `En-boy ${aspectPlan.aspect}: ${source.width}×${croppedHeight} → ` +
      `${expected.width}×${expected.height} (soldan ${aspectPlan.left}, sağdan ${aspectPlan.right}, üstten ${aspectPlan.top || 0}, alttan ${aspectPlan.bottom || 0} px)`,
    );
  }

  // Crossfade planı da onaydan önce: klibe sığmayan değer kimseye kare göstermeden dursun.
  const crossfade = crossfadeSeconds > 0
    ? planCrossfade({ duration: source.duration, fps: source.fps, crossfadeSeconds })
    : null;

  // 2 — Kırpma onayı (koşullu, HANDOFF bölüm 14/1)
  // Kontrol karesi nihai kadrajı gösterir: watermark + en-boy kırpması birlikte.
  const approval = await resolveCropApproval({
    clipPath, cropBottom, cropFilter: filters.join(','), before: source, after: expected,
    workspace, cropFromConfig, verifyCrop, assumeApproved, confirm, logger,
  });

  // 3 — Kırp, sesi at, gerekirse ölçekle
  await mkdir(dirname(outputPath), { recursive: true });

  if (scaleWidth) {
    // -2: yüksekliği en-boy oranına göre çift sayıya yuvarla (h264 şartı).
    filters.push(`scale=${scaleWidth}:-2`);
  }
  if (crossfade) {
    logger.info(
      `Loop crossfade: ${crossfade.fadeFrames} kare (${crossfadeSeconds} sn) — klip ` +
      `${crossfade.sourceFrames} → ${crossfade.outputFrames} kare.`,
    );
  }

  logger.info(
    `Kırpılıyor: ${source.width}×${source.height} → ${expected.width}×${expected.height}` +
    (scaleWidth ? `, ${scaleWidth} px genişliğe ölçekleniyor` : ''),
  );

  await ffmpeg([
    '-i', clipPath,
    // Kırpma yoksa, en-boy adımı atlandıysa ve ölçek verilmediyse zincir boş kalır:
    // ffmpeg boş -vf'i "No filters specified in the graph description" ile reddeder.
    ...(crossfade
      ? ['-filter_complex', buildCrossfadeFilter(crossfade, filters)]
      : (filters.length > 0 ? ['-vf', filters.join(',')] : [])),
    '-an',                       // Hailuo'nun 32 kHz sesi kullanılmıyor
    '-c:v', 'libx264',
    '-crf', String(crf),
    '-preset', preset,
    // Sabit: filtre (xfade) biçimi yuv444p'ye çekebiliyor → High 4:4:4 profili,
    // çoğu oynatıcı/tarayıcı çözemiyor. base.mp4 her yolda yuv420p.
    '-pix_fmt', 'yuv420p',
    '-y', outputPath,
  ], { onProgress });

  const result = await probe(outputPath);

  if (result.hasAudio) {
    warn('base.mp4 hâlâ ses akışı taşıyor — -an beklendiği gibi çalışmamış.');
  }
  if (crossfade) {
    // Yanlış uzunluk loop'u sessizce bozar: bir kareden fazla sapma hata.
    const expectedSeconds = crossfade.outputFrames / crossfade.fps;
    if (Math.abs(result.duration - expectedSeconds) > 1.5 / crossfade.fps) {
      throw new Error(
        `Crossfade çıktısı ${result.duration} sn, beklenen ${expectedSeconds.toFixed(3)} sn ` +
        `(${crossfade.outputFrames} kare).`,
      );
    }
  }
  if (!scaleWidth && (result.width !== expected.width || result.height !== expected.height)) {
    throw new Error(
      `Kırpma tutmadı: ${result.width}×${result.height}, beklenen ` +
      `${expected.width}×${expected.height}.`,
    );
  }

  // 4 — Loop kontrolü
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
    aspect: aspectPlan,
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
    crossfade,
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
    clipPath, cropBottom, cropFilter, before, after, workspace,
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
    '-vf', cropFilter,
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
    before: { width: before.width, height: before.height },
    after,
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
 * Crossfade'i kare cinsinden planlar (saniye yuvarlaması xfade'de kare kaydırır).
 *
 * Klip N kare, C = crossfadeSeconds × fps. Çıktı, klibin [C, N) kısmının
 * sonuna [0, C) kısmının çapraz geçişle eklenmesidir:
 *
 *   çıktı:  orig C … orig N−C | orig N−C+1…N−1 ⨯ orig 0…C−2 | orig C−1
 *                              └─── C−1 karelik karışım ───┘
 *
 * Karışım C−1 kare sürer, çünkü xfade geçişin son karesinde eski görüntüden
 * 1/C iz bırakır; bir kare kısa tutulunca geçiş bitimindeki kare SAF orig C−1
 * olur. Çıktı N−C+1 kare: son karesi orig C−1, ilk karesi orig C — loop tekrarında
 * iki ardışık kare yan yana gelir.
 *
 * @param {{ duration: number, fps: number, crossfadeSeconds: number }} p
 */
export function planCrossfade({ duration, fps, crossfadeSeconds }) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('Crossfade için kare hızı okunamadı.');
  }
  const sourceFrames = Math.round(duration * fps);
  const fadeFrames = Math.round(crossfadeSeconds * fps);

  if (fadeFrames < 2) {
    throw new Error(
      `crossfadeSeconds (${crossfadeSeconds}) en az iki kare olmalı (${fps} fps'te ${(2 / fps).toFixed(3)} sn).`,
    );
  }
  if (fadeFrames * 2 - 1 > sourceFrames) {
    throw new Error(
      `crossfadeSeconds (${crossfadeSeconds} sn = ${fadeFrames} kare) klibin yarısından ` +
      `uzun (${sourceFrames} kare): geçişin iki ucu üst üste biner.`,
    );
  }

  const blendFrames = fadeFrames - 1;
  const bodyFrames = sourceFrames - fadeFrames;

  return {
    fps,
    sourceFrames,
    fadeFrames,
    blendFrames,
    outputFrames: sourceFrames - fadeFrames + 1,
    /** xfade başlangıcı: gövdenin son blendFrames karesinin başı. */
    offsetSeconds: (bodyFrames - blendFrames) / fps,
    blendSeconds: blendFrames / fps,
  };
}

/**
 * Crossfade filtre zinciri. Kırpma/ölçekleme önce uygulanır, sonra bölünür.
 *
 * @param {ReturnType<typeof planCrossfade>} plan
 * @param {string[]} filters kırpma/ölçekleme zinciri
 * @returns {string}
 */
function buildCrossfadeFilter(plan, filters) {
  const { sourceFrames, fadeFrames, offsetSeconds, blendSeconds } = plan;

  return (
    // format=yuv420p: xfade'e biçimi seçtirilirse RGB/yuv444'e çevirip renk kaydırıyor.
    `[0:v]${filters.length > 0 ? `${filters.join(',')},` : ''}format=yuv420p,split[a][b];` +
    `[a]trim=start_frame=${fadeFrames}:end_frame=${sourceFrames},setpts=PTS-STARTPTS[body];` +
    `[b]trim=start_frame=0:end_frame=${fadeFrames},setpts=PTS-STARTPTS[head];` +
    `[body][head]xfade=transition=fade:duration=${blendSeconds}:offset=${offsetSeconds}`
  );
}
