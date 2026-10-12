/**
 * Aşama 4b — Montaj.
 *
 * base.mp4 (5 sn, sessiz) + mix.wav (48 dk, float PCM) → sona fade'li, müzikli video.
 * Ambient bu çıktının üzerine 03-ambient-mix.js ile eklenir.
 *
 * Elle yapılan süreçte (bölüm 6, adım 6–7) önce kopyayla mux edilip sonra
 * fade için 48 dakikanın tamamı yeniden encode edildi — 17 dakika sürdü.
 * Oysa fade yalnızca son 5 saniyeye dokunuyor. Burada:
 *
 *   gövde : base.mp4'ün tam tekrarları, concat demuxer ile KOPYALANIR
 *   kuyruk: kalan kareler (fade dahil) base.mp4'ten yeniden ENCODE edilir
 *
 * Kuyruk, gövdeyle aynı encoder ayarlarıyla aynı kaynaktan üretildiği için
 * akış parametreleri (SPS/PPS) birebir aynı çıkar ve kopyayla eklenebilir.
 * Aynı çıkmazsa sessizce bozuk dosya üretmek yerine tam encode'a düşülür.
 *
 * Pomodoro'da çalışma ve mola için ayrı görüntü verilebilir (`sessionVideo`):
 * her oturum KENDİ görüntüsünün döngüsüyle, o oturumun süresi kadar kurulur ve
 * sırayla birleştirilir (kare planı: core/session-video.js). Gövde/kuyruk
 * mantığı aynı, yalnızca oturum başına uygulanır; tek görüntüde hiçbir şey değişmez.
 */

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ffmpeg, ffprobe } from '../core/ffmpeg.js';
import { concatLine } from '../core/files.js';
import { parameterSetMismatches, readParameterSets } from '../core/h264.js';
import { durationsMatch, probe } from '../core/probe.js';
import { planSessionFrames, sessionJunctionPoints } from '../core/session-video.js';

const DEFAULTS = {
  fadeOut: 5,
  crf: 16,
  preset: 'slow',
  bitrate: '192k',
  /** Birleşme noktası kontrolünde noktanın iki yanında çözülecek süre (sn). */
  junctionWindow: 2,
};

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Loop videosunu müzik boyunca çoğaltır, sona fade ekler, sesi mux eder.
 *
 * @param {object} options
 * @param {string} options.videoPath base.mp4 (01-video-prep.js çıktısı)
 * @param {string} options.audioPath mix.wav ya da final_mix.wav (02/03 çıktısı)
 * @param {string} options.outputPath
 * @param {object} options.workspace core/workspace.js örneği
 * @param {number} [options.fadeOut] sondaki fade süresi (sn), 0 = fade yok
 * @param {number} [options.crf] base.mp4 üretilirken kullanılan değerle AYNI olmalı
 * @param {string} [options.preset] base.mp4 üretilirken kullanılan değerle AYNI olmalı
 * @param {string} [options.bitrate]
 * @param {'auto'|'full'} [options.strategy] auto: gövde kopya + kuyruk encode,
 *   uyumsuzlukta tam encode'a düşer. full: her zaman tam encode.
 * @param {string|null} [options.overlayFilter] etiket (drawtext) zinciri —
 *   core/label-filter.js. Verilirse strateji `full`'a zorlanır; null/yoksa eski davranış.
 * @param {{ sessions: Array<{ kind: 'work'|'break', startSeconds: number, endSeconds: number }>,
 *   breakVideoPath: string }|null} [options.sessionVideo] Pomodoro: `videoPath` çalışma
 *   görüntüsü, `breakVideoPath` mola görüntüsü (aynı boyut ve kare hızında base). null → tek görüntü.
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function assembleVideo(options) {
  const {
    videoPath,
    audioPath,
    outputPath,
    workspace,
    fadeOut = DEFAULTS.fadeOut,
    crf = DEFAULTS.crf,
    preset = DEFAULTS.preset,
    bitrate = DEFAULTS.bitrate,
    strategy: requestedStrategy = 'auto',
    overlayFilter = null,
    sessionVideo = null,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;
  // Etiket (drawtext) her karenin üstüne yazılır: gövdeyi kopyalamak mümkün
  // değil, tam encode şart. Etiket yoksa yöntem seçimi aynen eskisi gibi.
  const strategy = overlayFilter ? 'full' : requestedStrategy;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  const startedAt = Date.now();

  // 1 — Girdileri tanı
  const video = await probe(videoPath);
  const audio = await probe(audioPath);

  if (!video.hasVideo) throw new Error(`Video akışı yok: ${videoPath}`);
  if (!audio.hasAudio) throw new Error(`Ses akışı yok: ${audioPath}`);
  if (video.hasAudio) {
    warn('base.mp4 ses akışı taşıyor — yok sayılıyor, yalnızca video alınacak.');
  }
  if (!video.fps) throw new Error(`Kare hızı okunamadı: ${videoPath}`);

  // 2 — Planı kare cinsinden kur (saniye yuvarlaması birikmesin)
  const breakVideo = sessionVideo ? await probe(sessionVideo.breakVideoPath) : null;
  if (breakVideo) {
    if (!breakVideo.hasVideo) throw new Error(`Mola görüntüsünde video akışı yok: ${sessionVideo.breakVideoPath}`);
    if (breakVideo.width !== video.width || breakVideo.height !== video.height || breakVideo.fps !== video.fps) {
      throw new Error(
        `Mola görüntüsü çalışma görüntüsüyle aynı boyut ve kare hızında değil: ` +
        `${breakVideo.width}×${breakVideo.height}@${breakVideo.fps} / ${video.width}×${video.height}@${video.fps}.`,
      );
    }
  }

  const plan = sessionVideo
    ? planSessionFrames({
      sessions: sessionVideo.sessions,
      fps: video.fps,
      clipFrames: {
        work: Math.round(video.duration * video.fps),
        break: Math.round(breakVideo.duration * video.fps),
      },
      totalFrames: Math.round(audio.duration * video.fps),
      fadeFrames: Math.min(Math.round(fadeOut * video.fps), Math.round(audio.duration * video.fps)),
    })
    : planFrames({
      clipDuration: video.duration,
      fps: video.fps,
      targetDuration: audio.duration,
      fadeOut,
    });

  logger.info(
    sessionVideo
      ? `Hedef ${audio.duration} sn = ${plan.totalFrames} kare, ${plan.parts.length} oturum ` +
        `(her oturum kendi görüntüsüyle; ${plan.fadeFrames} kare fade).`
      : `Hedef ${audio.duration} sn = ${plan.totalFrames} kare. Gövde: ${plan.copies} × ` +
        `${plan.clipFrames} kare (kopya), kuyruk: ${plan.tailFrames} kare (encode, ` +
        `${plan.fadeFrames} kare fade).`,
  );

  await mkdir(dirname(outputPath), { recursive: true });
  const audioArgs = buildAudioArgs({ duration: audio.duration, fadeOut, bitrate });

  // 3 — Üret
  let method = strategy === 'full' ? 'full-encode' : 'copy-body+encode-tail';
  let tail = null;
  let sessionList = null;

  if (sessionVideo) {
    const paths = { work: videoPath, break: sessionVideo.breakVideoPath };
    // Etiket/fade filtreyle gelecekse (tam encode) kuyruğa fade yazılmaz: iki kez kararırdı.
    const withFade = method !== 'full-encode';
    sessionList = await buildSessionList({ plan, paths, workspace, crf, preset, withFade, logger });
    if (sessionList.mismatch) {
      warn(
        `Oturum görüntüleri kopyayla birleşmiyor (${sessionList.mismatch}) — her oturum ` +
        'yeniden encode edilip birleştirilecek (uzun sürer).',
      );
      sessionList = await buildSessionList({
        plan, paths, workspace, crf, preset, withFade, allEncoded: true, logger,
      });
      if (sessionList.mismatch) {
        throw new Error(`Oturum görüntüleri birleştirilemiyor: ${sessionList.mismatch}`);
      }
      if (method !== 'full-encode') method = 'encode-sessions';
    }
  } else if (method === 'copy-body+encode-tail' && plan.tailFrames > 0) {
    tail = await encodeTail({
      videoPath, workspace, tailFrames: plan.tailFrames, fadeFrames: plan.fadeFrames, crf, preset, logger,
    });

    if (!tail.compatible) {
      warn(
        `Kuyruk akış parametreleri gövdeyle uyuşmuyor (${tail.mismatch}) — kopyayla ` +
        'birleştirmek bozuk dosya üretir. Tam encode\'a düşülüyor (uzun sürer).',
      );
      method = 'full-encode';
    }
  }

  if (method !== 'full-encode') {
    let listPath;
    if (sessionList) {
      listPath = sessionList.listPath;
    } else {
      const lines = Array.from({ length: plan.copies }, () => concatLine(videoPath));
      if (tail) lines.push(concatLine(tail.path));
      listPath = await workspace.writeText('video-list.txt', lines.join('\n') + '\n');
    }

    logger.info('Gövde kopyalanıyor, ses mux ediliyor (video yeniden encode edilmiyor).');
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-i', audioPath,
      ...audioArgs.filter,
      '-map', '0:v',
      '-map', audioArgs.map,
      '-c:v', 'copy',
      ...audioArgs.codec,
      // moov atomu başa alınır: bu dosyayı Shorts ekranı `<video>` ile
      // AKITIYOR — moov sonda kalırsa tarayıcı metadata için 500+ MB'ı
      // indirmek zorunda kalıyor ve oynatıcı/timeline hiç açılmıyor
      // (07 ve 08 zaten faststart yazıyordu, 04 atlanmıştı).
      '-movflags', '+faststart',
      '-t', String(audio.duration),
      '-y', outputPath,
    ], { onProgress });
  } else {
    logger.info(
      `Tam encode: ${plan.totalFrames} kare yeniden encode ediliyor` +
      `${overlayFilter ? ' (etiketler yakılıyor — gövde kopyalanamaz, uzun sürer)' : ''}.`,
    );
    // Etiketler fade'den ÖNCE: video kararırken yazılar da onunla söner.
    const videoFilter = [
      overlayFilter,
      plan.fadeFrames > 0
        ? `fade=t=out:s=${plan.totalFrames - plan.fadeFrames}:n=${plan.fadeFrames}`
        : null,
    ].filter(Boolean).join(',') || 'null';
    await ffmpeg([
      ...(sessionList
        ? ['-f', 'concat', '-safe', '0', '-i', sessionList.listPath]
        : ['-stream_loop', '-1', '-i', videoPath]),
      '-i', audioPath,
      '-filter_complex', `[0:v]${videoFilter}[v]` +
        (audioArgs.filterGraph ? `;${audioArgs.filterGraph}` : ''),
      '-map', '[v]',
      '-map', audioArgs.map,
      '-frames:v', String(plan.totalFrames),
      '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
      '-pix_fmt', 'yuv420p',
      ...audioArgs.codec,
      '-movflags', '+faststart',
      '-t', String(audio.duration),
      '-y', outputPath,
    ], { onProgress });
  }

  // 4 — Doğrula
  const result = await probe(outputPath);

  if (!durationsMatch(result.duration, audio.duration)) {
    throw new Error(
      `Çıktı süresi müzikten farklı: ${result.duration} sn / ${audio.duration} sn.`,
    );
  }
  if (result.width !== video.width || result.height !== video.height) {
    throw new Error(
      `Çözünürlük değişmiş: ${result.width}×${result.height}, beklenen ` +
      `${video.width}×${video.height}.`,
    );
  }
  if (!result.hasAudio) throw new Error('Çıktıda ses akışı yok.');

  const frameCount = await countVideoPackets(outputPath);
  // -t ses süresinde keser; video en fazla bir kare eksik/fazla kalabilir.
  if (Math.abs(frameCount - plan.totalFrames) > 1) {
    throw new Error(
      `Kare sayısı tutmuyor: ${frameCount}, beklenen ${plan.totalFrames}.`,
    );
  }

  const junctions = method !== 'full-encode'
    ? await checkJunctions({
      path: outputPath,
      points: sessionVideo ? sessionJunctionPoints(plan) : junctionPoints(plan),
      logger,
    })
    : [];
  const brokenJunctions = junctions.filter((j) => !j.clean);
  if (brokenJunctions.length > 0) {
    throw new Error(
      'Birleşme noktası bozuk: ' +
      brokenJunctions.map((j) => `${j.kind} @ ${j.seconds} sn: ${j.error}`).join('; '),
    );
  }

  const elapsedSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  logger.info(`Montaj yöntemi: ${method}.`);

  return {
    output: outputPath,
    method,
    labels: Boolean(overlayFilter),
    elapsedSeconds,
    plan,
    tail: tail && { frames: plan.tailFrames, compatible: tail.compatible, mismatch: tail.mismatch },
    sessions: sessionVideo ? plan.parts : null,
    junctions,
    fade: fadeOut > 0
      ? { start: Number((audio.duration - fadeOut).toFixed(3)), duration: fadeOut }
      : null,
    result: {
      duration: result.duration,
      width: result.width,
      height: result.height,
      fps: result.fps,
      frames: frameCount,
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      sampleRate: result.sampleRate,
      size: result.size,
    },
    warnings,
  };
}

/**
 * Hedef süreyi tam klip tekrarlarına ve bir kuyruğa böler.
 *
 * Kuyruk her zaman fade'in tamamını içerir ve klibin 0. karesinden başlar —
 * böylece gövde→kuyruk geçişi, gövdedeki klip→klip geçişiyle aynı loop noktası.
 *
 * @param {{ clipDuration: number, fps: number, targetDuration: number, fadeOut: number }} p
 */
export function planFrames({ clipDuration, fps, targetDuration, fadeOut }) {
  const clipFrames = Math.round(clipDuration * fps);
  const totalFrames = Math.round(targetDuration * fps);
  const fadeFrames = Math.min(Math.round(fadeOut * fps), totalFrames);

  if (clipFrames <= 0 || totalFrames <= 0) {
    throw new Error(`Geçersiz süre: klip ${clipDuration} sn, hedef ${targetDuration} sn.`);
  }

  const copies = Math.floor((totalFrames - fadeFrames) / clipFrames);
  const tailFrames = totalFrames - copies * clipFrames;

  return {
    fps,
    clipFrames,
    totalFrames,
    fadeFrames,
    copies,
    tailFrames,
    tailStartSeconds: Number(((copies * clipFrames) / fps).toFixed(3)),
  };
}

/**
 * Ses dalı argümanları. Ses her durumda encode edilir: afade gerektiriyor ve
 * 48 dakikalık sesi AAC'ye çevirmek saniyeler sürüyor.
 */
function buildAudioArgs({ duration, fadeOut, bitrate }) {
  const codec = ['-c:a', 'aac', '-b:a', bitrate];

  if (fadeOut <= 0) {
    return { filter: [], filterGraph: null, map: '1:a', codec };
  }

  const start = Math.max(0, duration - fadeOut);
  const filterGraph = `[1:a]afade=t=out:st=${start}:d=${fadeOut}[a]`;
  return { filter: ['-filter_complex', filterGraph], filterGraph, map: '[a]', codec };
}

/**
 * Kuyruğu base.mp4'ten encode eder ve gövdeyle kopyayla birleşip
 * birleşemeyeceğini kontrol eder.
 *
 * @param {object} p
 * @param {string} p.videoPath kuyruğun alındığı base (0. kareden başlar)
 * @param {string} [p.name] workspace içindeki dosya adı
 * @param {number} p.tailFrames
 * @param {number} p.fadeFrames kuyruğun SONUNDAKİ kararma, 0 = yok
 */
async function encodeTail({
  videoPath, workspace, name = 'tail.mp4', tailFrames, fadeFrames, crf, preset, logger,
}) {
  const path = workspace.path(name);
  const source = await streamSignature(videoPath);

  const fade = fadeFrames > 0
    ? ['-vf', `fade=t=out:s=${tailFrames - fadeFrames}:n=${fadeFrames}`]
    : [];

  logger.info(`Kuyruk encode ediliyor (${name}): ${tailFrames} kare.`);
  await ffmpeg([
    '-stream_loop', '-1', '-i', videoPath,
    '-an',
    ...fade,
    '-frames:v', String(tailFrames),
    '-c:v', 'libx264', '-crf', String(crf), '-preset', preset,
    '-pix_fmt', source.pixFmt,
    // concat demuxer zaman tabanı farklı parçalarda damgaları yeniden ölçekler;
    // aynı tutmak kare süresinin kaymasını önler.
    '-video_track_timescale', String(source.timescale),
    '-y', path,
  ]);

  const produced = await streamSignature(path);
  const mismatch = signatureMismatches(source, produced);

  return {
    path,
    signature: produced,
    compatible: mismatch.length === 0,
    mismatch: mismatch.length ? mismatch.join(', ') : null,
  };
}

/** Kopyayla birleşmeyi belirleyen akış parametreleri (bkz. streamSignature). */
const SIGNATURE_KEYS = ['codec', 'profile', 'level', 'pixFmt', 'width', 'height', 'timescale', 'extradata'];

/** İki akışın farklı olduğu parametre adları; boşsa kopyayla birleşebilirler. */
function signatureMismatches(a, b) {
  return SIGNATURE_KEYS.filter((key) => a[key] !== b[key]);
}

/**
 * Oturum görüntülerinin birleştirme listesi: her oturum için kendi base'inin
 * tam tekrarları (kopya) + gerekirse encode edilmiş bir kuyruk.
 *
 * `mismatch` doluysa liste kopyayla güvenle birleşmez (iki görüntünün akış
 * parametreleri ya da bir kuyruk kendi base'inden farklı): çağıran `allEncoded`
 * ile her oturumu baştan encode ettirir — hepsi aynı encoder ayarıyla çıktığı
 * için birbirleriyle uyumlu olur.
 *
 * @param {object} p
 * @param {ReturnType<typeof planSessionFrames>} p.plan
 * @param {{ work: string, break: string }} p.paths
 * @param {boolean} p.withFade son oturumun kuyruğuna fade yazılsın mı
 * @param {boolean} [p.allEncoded] tekrarlar da kuyruk gibi encode edilir
 * @returns {Promise<{ listPath: string, mismatch: string|null }>}
 */
async function buildSessionList({
  plan, paths, workspace, crf, preset, withFade, allEncoded = false, logger,
}) {
  const baseSignatures = {
    work: await streamSignature(paths.work),
    break: await streamSignature(paths.break),
  };
  const baseDiff = signatureMismatches(baseSignatures.work, baseSignatures.break);
  // Yeniden encode edince yalnızca boyut/zaman tabanı farkı kurtarılamaz;
  // extradata/profil farkı encode'la zaten ortadan kalkar.
  const unfixable = baseDiff.filter((key) => ['width', 'height', 'timescale'].includes(key));
  let mismatch = (allEncoded ? unfixable : baseDiff).length > 0
    ? `çalışma ve mola görüntüsü: ${(allEncoded ? unfixable : baseDiff).join(', ')}`
    : null;

  const lines = [];
  const produced = [];
  for (const part of plan.parts) {
    const base = paths[part.kind];
    const copies = allEncoded ? 0 : part.copies;
    const tailFrames = allEncoded ? part.frames : part.tailFrames;
    for (let i = 0; i < copies; i++) lines.push(concatLine(base));
    if (tailFrames > 0) {
      const tail = await encodeTail({
        videoPath: base,
        workspace,
        name: `tail-${part.index}.mp4`,
        tailFrames,
        fadeFrames: withFade ? part.fadeFrames : 0,
        crf,
        preset,
        logger,
      });
      produced.push(tail);
      if (!allEncoded && !tail.compatible && mismatch === null) {
        mismatch = `oturum ${part.index + 1} kuyruğu: ${tail.mismatch}`;
      }
      lines.push(concatLine(tail.path));
    }
  }

  if (allEncoded) {
    // Hepsi yeniden encode edildi: kendi aralarında uyumlu olmalı.
    const [first, ...rest] = produced;
    for (const tail of rest) {
      const diff = signatureMismatches(first.signature, tail.signature);
      if (diff.length > 0 && mismatch === null) mismatch = `encode edilen oturumlar: ${diff.join(', ')}`;
    }
  }

  const listPath = await workspace.writeText('video-list.txt', lines.join('\n') + '\n');
  return { listPath, mismatch };
}

/**
 * Kopyayla birleştirmenin güvenli olup olmadığını belirleyen akış parametreleri.
 * extradata (avcC: SPS/PPS) farklıysa demuxer ilk dosyanınkini kullanır ve
 * kuyruk yanlış çözülür — bu yüzden bayt bayt karşılaştırılıyor.
 *
 * @param {string} path
 */
async function streamSignature(path) {
  const { stdout } = await ffprobe([
    '-select_streams', 'v:0',
    '-show_data',
    '-show_entries', 'stream=codec_name,profile,level,pix_fmt,width,height,time_base,extradata',
    '-of', 'json',
    path,
  ]);
  const stream = JSON.parse(stdout).streams?.[0] ?? {};
  const [, denominator] = String(stream.time_base ?? '').split('/');

  return {
    codec: stream.codec_name,
    profile: stream.profile,
    level: stream.level,
    pixFmt: stream.pix_fmt,
    width: stream.width,
    height: stream.height,
    timescale: Number(denominator),
    // hexdump satırlarından yalnızca bayt sütunları
    extradata: String(stream.extradata ?? '')
      .split('\n')
      .map((line) => line.slice(10, 50).replace(/\s/g, ''))
      .join(''),
  };
}

/**
 * Video akışındaki paket (kare) sayısı. Çözmeden sayar, 48 dakikada saniyeler sürer.
 * @param {string} path
 */
async function countVideoPackets(path) {
  const { stdout } = await ffprobe([
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=nb_read_packets',
    '-of', 'csv=p=0',
    path,
  ]);
  return Number(stdout.trim());
}

/**
 * Birleşme noktaları: klip→klip (kopya+kopya) ve gövde→kuyruk (kopya+encode).
 * @param {ReturnType<typeof planFrames>} plan
 */
export function junctionPoints(plan) {
  const points = [];
  if (plan.copies >= 2) {
    points.push({ kind: 'klip→klip', seconds: Number((plan.clipFrames / plan.fps).toFixed(3)) });
  }
  if (plan.copies >= 1 && plan.tailFrames > 0) {
    points.push({ kind: 'gövde→kuyruk', seconds: plan.tailStartSeconds });
  }
  return points;
}

/**
 * Her birleşme noktasının çevresinde iki kontrol:
 *
 *   1. Çözme (`-xerror`): bozuk paket, eksik referans.
 *   2. Parametre setleri: akış içine gömülen SPS/PPS, konteynerin avcC'siyle
 *      içerik olarak aynı mı. Uyuşmazlık ffmpeg'de hatasız çözülür (1. kontrol
 *      geçer, kareler bile doğru görünür) ama avcC'ye güvenen çözücüleri bozar —
 *      bu yüzden asıl sinyal bu (core/h264.js).
 *
 * @param {{ path: string, points: Array<{ kind: string, seconds: number }>, logger?: object }} p
 */
export async function checkJunctions({ path, points, logger = NOOP_LOGGER }) {
  const results = [];
  for (const point of points) {
    const start = Math.max(0, point.seconds - DEFAULTS.junctionWindow);
    const duration = DEFAULTS.junctionWindow * 2;
    const errors = [];

    try {
      const { stderr } = await ffmpeg([
        '-xerror', '-ss', String(start), '-i', path, '-t', String(duration),
        '-map', '0:v', '-f', 'null', '-',
      ]);
      if (stderr.trim()) errors.push(`çözme: ${stderr.trim().split('\n')[0]}`);
    } catch (cause) {
      errors.push(`çözme: ${cause.message.split('\n')[0]}`);
    }

    const mismatches = parameterSetMismatches(await readParameterSets(path, { start, duration }));
    for (const m of mismatches) {
      errors.push(`${m.type} ${m.id} konteynerden farklı (${m.reason})`);
    }

    results.push({ ...point, clean: errors.length === 0, error: errors.join('; ') || null });
  }

  for (const r of results) {
    logger.info(`Birleşme noktası ${r.kind} @ ${r.seconds} sn: ${r.clean ? 'temiz' : `HATA — ${r.error}`}`);
  }
  return results;
}
