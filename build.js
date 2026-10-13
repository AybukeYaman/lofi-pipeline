#!/usr/bin/env node
/**
 * Aşama 5b — Orkestratör.
 *
 *   node build.js [--project ./project.json] [--crop-bottom N] [--verify-crop]
 *                 [--aspect 16:9|off] [--scale 2560] [--keep] [--overwrite]
 *
 * ÇALIŞMA SIRASI dosya numaralarından farklıdır (numaralar yazılma sırası):
 *
 *   0  konfig doğrulama + çıktı çakışma kontrolü      (encode yok)
 *   1  01-video-prep    kırpma onayı, watermark + 16:9 → base.mp4
 *   2  02-audio-concat  parçalar → mix.wav, sonra disk kontrolü
 *   3  03-ambient-mix   (opsiyonel) ambient → mix'e karışır (yalnız ses; video bir kez yazılır)
 *   4  04-assemble      base × n + ses + fade → nihai video
 *   5  06-pomodoro-cues (opsiyonel) her oturumun son 3 saniyesinde 3 bip sese biner
 *   5  05-tracklist     damgalar
 *   6  çıktıları taşı, rapor yaz, workspace'i temizle
 *
 * Nihai dosyalar workspace'te üretilir ve iş bitince çıktı klasörüne `rename`
 * edilir: yarıda kesilen build çıktı klasörüne yarım dosya bırakmaz (bölüm 8).
 */

import { copyFile, mkdir, rename, stat, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { ConfigError, loadProject } from './core/config.js';
import { abortAll } from './core/ffmpeg.js';
import { PomodoroValidationError, describeTimeline } from './core/pomodoro-plan.js';
import { AUDIO_EXTENSIONS, listFiles } from './core/files.js';
import { createWorkspace, writeTextFile } from './core/workspace.js';
import { CropNotConfirmedError, prepareVideo } from './steps/01-video-prep.js';
import { concatAudio } from './steps/02-audio-concat.js';
import { mixAmbient } from './steps/03-ambient-mix.js';
import { assembleVideo } from './steps/04-assemble.js';
import { hasAudioZips } from './prep/audio-zip.js';
import { discardUnusedMusic } from './prep/unused-music.js';
import { prepareLabelOverlay } from './steps/04a-label-overlay.js';
import { writeTracklist } from './steps/05-tracklist.js';
import { mixPomodoroCues } from './steps/06-pomodoro-cues.js';
import { buildStreamPackage } from './steps/07-stream-package.js';
import { distinctVisuals } from './core/session-video.js';

/** Disk tahminine eklenen pay: ses, geçici wav'lar, tahmin hatası. */
const DISK_MARGIN = { ratio: 1.1, bytes: 200 * 1024 * 1024 };

const NOOP_LOGGER = { info() {}, warn() {} };

export class BuildError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BuildError';
  }
}

export class BuildCancelledError extends Error {
  constructor() {
    super('Build kullanıcı tarafından iptal edildi.');
    this.name = 'BuildCancelledError';
  }
}

/**
 * Tüm zinciri çalıştırır.
 *
 * @param {object} config core/config.js → loadProject çıktısı
 * @param {object} [options]
 * @param {(tag: string) => { info: Function, warn: Function }} [options.loggerFor]
 * @param {(info: object) => Promise<boolean>} [options.confirm] kırpma onayı; yoksa
 *   onay gereken durumda CropNotConfirmedError
 * @param {(tag: string, seconds: number, total: number|null) => void} [options.onProgress]
 * @param {boolean} [options.overwrite]
 * @param {boolean} [options.render] uzun videoyu da üret (varsayılan: yalnızca
 *   yayın paketi). Render 24/7 yayın için gerekmiyor ve çıktının 30-60 katı yer
 *   kaplıyor; VOD gerektiğinde açıkça istenir.
 * @param {boolean} [options.keep] workspace silinmez
 * @param {AbortSignal} [options.signal] adımlar arasında denetlenir
 * @param {(path: string) => Promise<void>} [options.trashFile] hiç kullanılmayan müzik parçalarını
 *   Geri Dönüşüm Kutusu'na taşıyan işlev (varsayılan: core/trash.js); testte sahte.
 * @param {(dir: string) => Promise<number>} [options.diskFree] klasörün bulunduğu
 *   sürücüdeki boş bayt. Varsayılan fs.statfs; testte dar disk taklidi için.
 * @returns {Promise<object>} rapor
 */
export async function runBuild(config, options = {}) {
  const {
    loggerFor = () => NOOP_LOGGER,
    confirm,
    onProgress,
    overwrite = false,
    render = false,
    keep = false,
    signal,
    diskFree = freeBytesOf,
    trashFile,
  } = options;

  const log = loggerFor('build');
  const startedAt = Date.now();
  const steps = [];
  const warnings = config.warnings.map((message) => ({ step: 'config', message }));
  for (const w of config.warnings) log.warn(w);

  // --- 0: çıktı çakışması (hiçbir şey üretmeden)
  // Yalnızca render edilen çıktılar çakışabilir; yayın paketi her çalışmada
  // yeni albüm adı alıyor (steps/07 freeAlbumName).
  const targets = render ? [config.output.video, config.output.tracklist] : [];
  if (!overwrite) {
    const existing = [];
    for (const path of targets) if (await exists(path)) existing.push(path);
    if (existing.length > 0) {
      throw new BuildError(
        `Çıktı zaten var, üzerine yazmak için --overwrite ver:\n` +
        existing.map((p) => `  ${p}`).join('\n'),
      );
    }
  }

  // Zip'ler web arayüzü açılırken açılıyor (prep/audio-zip.js); CLI'dan doğrudan çalışırken
  // klasörde kalmışsa müzik listesine girmez — sessizce yok sayılmasın.
  if (await hasAudioZips(config.audioDir)) {
    const message = 'Müzik klasöründe açılmamış zip var — içindeki parçalar kullanılmayacak. ' +
      'Önce web arayüzünde projeyi açın (zip otomatik açılır) ya da zipi elle klasöre çıkarın.';
    warnings.push({ step: 'config', message });
    log.warn(message);
  }

  await mkdir(config.output.dir, { recursive: true });
  // Workspace çıktıyla aynı klasörde → sonunda kopya değil rename (1.6 GB).
  const workspace = await createWorkspace({ root: config.output.dir, keep });
  log.info(`Workspace: ${workspace.dir}`);

  /**
   * Bir adımı süre ölçerek çalıştırır, raporunu ve uyarılarını toplar.
   * @template T
   * @param {string} tag
   * @param {string} name
   * @param {(logger: object) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const step = async (tag, name, fn) => {
    if (signal?.aborted) throw new BuildCancelledError();
    const logger = loggerFor(tag);
    logger.info(`${name} başlıyor.`);
    const t0 = Date.now();
    const report = await fn(logger);
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1));
    logger.info(`${name} bitti: ${seconds} sn.`);
    steps.push({ tag, name, seconds, report });
    for (const message of report?.warnings ?? []) warnings.push({ step: tag, message });
    return report;
  };
  const progress = (tag, total) => (onProgress ? (s) => onProgress(tag, s, total) : undefined);

  /**
   * Yayın paketi (07) — 24/7 yayının asıl çıktısı.
   *
   * Render'dan BAĞIMSIZ: kısa döngüyü ve parçaları doğrudan kaynaklardan
   * üretiyor, uzun videoya ihtiyacı yok. Bu yüzden hem render'sız hem
   * render'lı çalışmada aynı yerden çağrılıyor.
   */
  const makeStreamPackage = async () => {
    if (!config.stream.enabled) {
      log.info('Yayın paketi kapalı (stream.enabled: false) — adım atlandı.');
      return null;
    }
    const trackPaths = await listFiles(config.audioDir, AUDIO_EXTENSIONS);
    return step('07', 'Yayın paketi', (logger) => buildStreamPackage({
      clipPath: config.clip,
      videoSource: config.video.source,
      crop: {
        bottom: config.video.cropBottom,
        top: config.video.cropTop,
        left: config.video.cropLeft,
        right: config.video.cropRight,
      },
      aspect: config.video.aspect,
      trackPaths,
      names: config.names,
      outDir: config.output.streamPackage,
      streamerDir: config.stream.dir,
      album: config.stream.album,
      logger,
      onProgress: progress('07', null),
    }));
  };

  try {
    // --- Render istenmediyse: uzun video hiç üretilmez. 24/7 yayın onu
    // kullanmıyor ve ölçüldüğüne göre çıktı malzemesinin 30-60 katı yer
    // kaplıyor, montaj da build süresinin %45-92'si.
    if (!render) {
      const streamPackage = await makeStreamPackage();
      const report = {
        project: config.projectPath,
        finishedAt: new Date().toISOString(),
        totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        mode: 'stream-package',
        rendered: false,
        outputs: streamPackage ? { streamPackage: streamPackage.dir } : {},
        streamPackage: streamPackage
          ? {
            album: streamPackage.album,
            dir: streamPackage.dir,
            published: streamPackage.published?.dir ?? null,
            trackCount: streamPackage.tracks.length,
            totalBytes: streamPackage.totalBytes,
            background: streamPackage.background,
          }
          : null,
        steps: steps.map(({ tag, name, seconds }) => ({ tag, name, seconds })),
        warnings,
        details: Object.fromEntries(steps.map(({ tag, report: r }) => [tag, r])),
      };
      await writeTextFile(config.output.report, JSON.stringify(report, null, 2) + '\n');
      return report;
    }

    // --- 1: video hazırlığı (onay burada — ucuz, pahalı adımlardan önce)
    const video = await step('01', 'Video hazırlığı', (logger) => prepareVideo({
      clipPath: config.clip,
      source: config.video.source,
      outputPath: workspace.path('base.mp4'),
      workspace,
      cropBottom: config.video.cropBottom,
      cropFromConfig: config.video.cropFromConfig,
      verifyCrop: config.video.verifyCrop,
      confirm,
      aspect: config.video.aspect,
      scaleWidth: config.video.scaleWidth ?? undefined,
      crf: config.video.crf,
      preset: config.video.preset,
      crossfadeSeconds: config.video.crossfadeSeconds,
      // Loop testi gözle bakmak için; workspace silinecekse üretmenin anlamı yok.
      loopTest: keep,
      logger,
    })).catch((error) => keepCropFrame(error, config.output.dir));

    // --- 1b: Pomodoro durum görüntüleri (opsiyonel). Her FARKLI görüntü (durumlar +
    // GET READY; ana görüntüden ayrı olanlar) ana görüntünün BOYUTUNA ve kare hızına
    // getirilir: oturumlar kopyayla birleşebilsin. Kırpma değerleri aynı; ana klip
    // için verilen onay burada yeniden sorulmaz. Aynı dosya iki durumda → tek base.
    const visuals = distinctVisuals(config.pomodoro, config.clip);
    const sessionBases = {};
    // Bir durumun görüntüsü ana klibin kendisiyse ana base kullanılır (ayrı base üretilmez).
    const usesMainClip = config.pomodoro
      && [config.pomodoro.intro, ...config.pomodoro.statuses].some((item) => item.visual === config.clip);
    if (usesMainClip) sessionBases[config.clip] = video.output;
    if (visuals.length > 0) {
      await step('01b', 'Durum görüntüleri hazırlığı', async (logger) => {
        const items = [];
        const warnings = [];
        for (const [i, visual] of visuals.entries()) {
          const prepared = await prepareVideo({
            clipPath: visual.path,
            source: visual.source,
            outputPath: workspace.path(`base.${i + 1}.mp4`),
            workspace,
            cropBottom: config.video.cropBottom,
            cropTop: config.video.cropTop,
            cropLeft: config.video.cropLeft,
            cropRight: config.video.cropRight,
            cropFromConfig: true,
            aspect: config.video.aspect,
            matchTo: {
              width: video.result.width,
              height: video.result.height,
              fps: video.result.fps,
            },
            crf: config.video.crf,
            preset: config.video.preset,
            crossfadeSeconds: config.video.crossfadeSeconds,
            loopTest: false,
            logger,
          });
          sessionBases[visual.path] = prepared.output;
          items.push({ visual: visual.path, ...prepared });
          warnings.push(...(prepared.warnings ?? []));
        }
        return { items, warnings };
      });
    }

    let configLine = null;
    if (video.crop.approval.required && !config.video.cropFromConfig) {
      configLine = `"video": { "cropBottom": ${config.video.cropBottom} }`;
      log.info(
        `Onaylanan değeri sonraki build'lerde sormaması için project.json'a ekle:\n    ${configLine}`,
      );
    }

    // --- 2: ses
    const audio = await step('02', 'Ses birleştirme', (logger) => concatAudio({
      audioDir: config.audioDir,
      outputPath: workspace.path('mix.wav'),
      order: config.order ?? undefined,
      // Pomodoro doğrulaması burada: parçalar ölçülüyor ama henüz
      // birleştirilmiyor — uymayan seçim tek kare encode edilmeden durur.
      pomodoro: config.pomodoro,
      logger,
      onProgress: progress('02', null),
    }));

    const ambientPlan = config.ambient;
    // Pomodoro açık ve yerleşen işaret varsa 06 çalışacak. Plan 02'de üretildi
    // (doğrulamayla aynı hesap); burada yeniden hesaplanmıyor.
    const pomodoro = audio.pomodoro.enabled ? audio.pomodoro : null;
    const cuePlan = pomodoro && pomodoro.cues.events.length > 0 ? pomodoro.cues : null;

    const disk = await checkDiskSpace({
      dir: config.output.dir,
      baseSize: video.result.size,
      baseDuration: video.result.duration,
      targetDuration: audio.duration,
      copies: 1, // ambient sese karıştığı için video yalnızca montajda yazılır
      // Ambiance karışımı mix.wav boyutunda TEK bir WAV daha yazar (parça
      // sayısından bağımsız): bütün döngüler tek amix çağrısında karışıyor.
      // Parça başına yazılan hazırlık/döngü dosyaları ambient'in kendi
      // uzunluğunda, mix.wav'ın yanında ihmal edilebilir.
      // Her ara karışım mix.wav boyutunda TEK bir WAV daha yazar: Ambiance (03)
      // ve Pomodoro işaretleri (06). İkisi de açıksa iki kopya.
      extraBytes: (ambientPlan ? audio.format.size : 0)
        + (cuePlan ? audio.format.size : 0),
      diskFree,
    });
    log.info(
      `Disk: ~${gb(disk.requiredBytes)} GB gerekli, ${gb(disk.freeBytes)} GB boş.`,
    );

    // --- 7: yayın paketi. Kırpma onayından (01) ve disk denetiminden SONRA —
    // onaylanmamış çerçeveyle ya da yer yokken yayına albüm çıkmasın. Ama
    // montajdan (04, 8-14 dk) ÖNCE: yayın asıl çıktı, render ona bağlı değil.
    const streamPackage = await makeStreamPackage();

    // --- 3: ambient (03, opsiyonel) — videoya değil sese karışır: 48 dakikalık
    // video yalnızca montajda bir kez yazılır. Müzik seviyesi mix.wav'dan ölçülür.
    let finalAudio = audio.output;
    if (ambientPlan) {
      const stepName = ambientPlan.tracks.length > 1
        ? `Ambiance karıştırma (${ambientPlan.tracks.length} parça, ${ambientPlan.mode})`
        : 'Ambiance karıştırma';
      const mixed = await step('03', stepName, (logger) => mixAmbient({
        audioPath: finalAudio,
        plan: ambientPlan,
        outputPath: workspace.path('final_mix.wav'),
        workspace,
        ambientOffsetDb: config.audio.ambientOffsetDb,
        fadeOut: config.video.fadeOut,
        logger,
        onProgress: progress('03', audio.duration),
      }));
      finalAudio = mixed.output;
    } else {
      log.info('Ambiance tanımlı değil — adım atlandı.');
    }

    // --- 3b: Pomodoro işaretleri (06, opsiyonel) — nihai sesin ÜZERİNE biner.
    // Müzik dosyalarına ve mix.wav'a dokunulmaz: Pomodoro kapatılırsa iz kalmaz.
    let cues = null;
    if (cuePlan) {
      cues = await step('06', `Pomodoro bipleri (${cuePlan.events.length} olay)`, (logger) => mixPomodoroCues({
        audioPath: finalAudio,
        plan: config.pomodoro,
        cues: cuePlan,
        outputPath: workspace.path('cue_mix.wav'),
        workspace,
        // Videonun son 3 saniyesindeki bipler de duyulsun: ses kararması müziğe
        // bipten ÖNCE uygulanır, montaj sesi ikinci kez kısmaz (fadeAudio: false).
        fadeOut: config.video.fadeOut,
        logger,
        onProgress: progress('06', audio.duration),
      }));
      finalAudio = cues.output;
    } else if (pomodoro) {
      log.info('Pomodoro açık ama bip kapalı — 06 atlandı.');
    }

    // --- 4a: etiket katmanı (opsiyonel). Etiket yoksa filter null → montaj eski
    // hızlı yoldan gider. Pomodoro oturumları 02'de üretilen plandan yalnızca OKUNUR.
    const labelOverlay = await prepareLabelOverlay({
      labels: config.labels,
      videoPath: video.output,
      sessions: pomodoro ? pomodoro.timeline.sessions : null,
      workspace,
      logger: log,
    });

    // --- 4: montaj (04) — gövde kopya, kuyruk (fade) encode; ses son karışım.
    // Etiket varsa gövde kopyalanamaz: tam encode.
    const finalVideo = workspace.path('final.mp4');
    const assembled = await step('04', 'Montaj', (logger) => assembleVideo({
      videoPath: video.output,
      audioPath: finalAudio,
      outputPath: finalVideo,
      overlayFilter: labelOverlay.filter,
      fadeAudio: cues === null,
      // Durumlar ayrı görüntü kullanıyorsa her oturum kendi görüntüsüyle kurulur.
      sessionVideo: pomodoro && Object.keys(sessionBases).length > 0
        ? { sessions: pomodoro.timeline.sessions, bases: sessionBases }
        : null,
      workspace,
      fadeOut: config.video.fadeOut,
      crf: config.video.crf,
      preset: config.video.preset,
      bitrate: config.audio.bitrate,
      logger,
      onProgress: progress('04', audio.duration),
    }));

    // --- 5: tracklist
    const tracklist = await step('05', 'Tracklist', (logger) => writeTracklist({
      tracks: audio.tracks,
      outputPath: workspace.path('tracklist.txt'),
      names: config.names,
      logger,
    }));

    // --- 6: teslim
    if (signal?.aborted) throw new BuildCancelledError();
    await rename(finalVideo, config.output.video);
    await rename(tracklist.output, config.output.tracklist);
    // Oturum dökümü (STUDY/BREAK…) ayrı dosyada: tracklist YouTube'un biçimi, bu ise
    // oturum planı. Pomodoro kapalıyken üretilmez.
    if (pomodoro) {
      await writeTextFile(config.output.pomodoroTimeline, describeTimeline(pomodoro.timeline));
    }

    // Fazla müzik montajda kırpıldı: hiç kullanılmayan parçalar klasörde kalmasın.
    // Yalnızca montaj bitip teslim edildikten SONRA — yarıda kalan montaj müzik kaybettirmez.
    let unusedMusic = null;
    if (pomodoro?.trim && pomodoro.trim.droppedCount > 0) {
      unusedMusic = await discardUnusedMusic({
        trim: pomodoro.trim,
        projectPath: config.projectPath,
        ...(trashFile ? { trashFile } : {}),
      });
      if (unusedMusic.moved.length > 0) {
        log.info(`Kullanılmayan ${unusedMusic.moved.length} müzik Geri Dönüşüm Kutusu'na taşındı: ${unusedMusic.moved.join(', ')}`);
      }
      for (const { file, error } of unusedMusic.failed) {
        const message = `Kullanılmayan müzik taşınamadı (${file}): ${error}`;
        warnings.push({ step: 'cleanup', message });
        log.warn(message);
      }
    }

    const report = {
      project: config.projectPath,
      finishedAt: new Date().toISOString(),
      totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      mode: 'render',
      rendered: true,
      outputs: {
        video: config.output.video,
        tracklist: config.output.tracklist,
        report: config.output.report,
        ...(pomodoro ? { pomodoroTimeline: config.output.pomodoroTimeline } : {}),
        ...(streamPackage ? { streamPackage: streamPackage.dir } : {}),
      },
      streamPackage: streamPackage
        ? {
          album: streamPackage.album,
          dir: streamPackage.dir,
          published: streamPackage.published?.dir ?? null,
          trackCount: streamPackage.tracks.length,
          totalBytes: streamPackage.totalBytes,
          background: streamPackage.background,
        }
        : null,
      musicDuration: audio.duration,
      sortSource: audio.sortSource,
      // Düz metin kalıyor: regresyon karşılaştırması (test/helpers/
      // regression-compare.js) bu alanı birebir eşitlikle kontrol ediyor.
      // Plan ayrıntısı ayrı alanda.
      ambient: ambientPlan ? 'mixed' : 'skipped',
      ambientPlan: ambientPlan
        ? {
          mode: ambientPlan.mode,
          crossfade: ambientPlan.crossfade,
          tracks: ambientPlan.tracks.map((track) => ({
            path: track.path, volumeDb: track.volumeDb,
          })),
        }
        : null,
      configLine,
      disk,
      // Düz metin alanı Ambiance ile aynı gerekçeyle: okuyan taraf tek bakışta
      // açık mı kapalı mı görsün, ayrıntı ayrı alanda.
      pomodoro: pomodoro ? 'applied' : 'off',
      unusedMusic,
      // Videoya yakılan etiket sayısı (0 = etiket yok, montaj eski hızlı yoldan geçti).
      labels: labelOverlay.labelCount,
      pomodoroPlan: pomodoro
        ? {
          statuses: config.pomodoro.statuses.map(({ name, minutes, beep }) => ({ name, minutes, beep })),
          rounds: config.pomodoro.rounds,
          preset: config.pomodoro.preset,
          totalSeconds: pomodoro.timeline.totalSeconds,
          sessions: pomodoro.timeline.sessions,
          comparison: pomodoro.comparison,
          trim: pomodoro.trim,
          cueEvents: cues ? cues.eventCount : 0,
        }
        : null,
      settings: {
        source: config.video.source,
        cropBottom: config.video.cropBottom,
        cropFromConfig: config.video.cropFromConfig,
        verifyCrop: config.video.verifyCrop,
        aspect: config.video.aspect,
        scaleWidth: config.video.scaleWidth,
        crf: config.video.crf,
        preset: config.video.preset,
        fadeOut: config.video.fadeOut,
        crossfadeSeconds: config.video.crossfadeSeconds,
        bitrate: config.audio.bitrate,
        ambientOffsetDb: config.audio.ambientOffsetDb,
      },
      steps: steps.map(({ tag, name, seconds }) => ({ tag, name, seconds })),
      warnings,
      details: Object.fromEntries(steps.map(({ tag, report: r }) => [tag, r])),
    };
    await writeTextFile(config.output.report, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    const cleanup = await workspace.cleanup().catch((error) => ({ error }));
    if (cleanup.error) {
      log.warn(`Workspace silinemedi (${cleanup.error.message}): ${workspace.dir}`);
    } else if (cleanup.removed) {
      log.info(`Workspace temizlendi (${gb(cleanup.freedBytes)} GB).`);
    } else {
      log.info(`Workspace bırakıldı (--keep): ${workspace.dir}`);
    }
  }
}

/**
 * Onay verilmeyen kırpmada kontrol karesini çıktı klasörüne kopyalar ve hatayı
 * yeni yolla yeniden fırlatır. Workspace `finally`'de silindiği için hatadaki
 * workspace yolu kullanıcıya ulaştığında açılmaz (HANDOFF bölüm 15, açık iş 2).
 * Kopyalanamazsa özgün hata olduğu gibi fırlatılır.
 *
 * @param {unknown} error
 * @param {string} outDir
 * @returns {Promise<never>}
 */
async function keepCropFrame(error, outDir) {
  if (!(error instanceof CropNotConfirmedError) || !error.framePath) throw error;
  const keptPath = join(outDir, 'crop-check.png');
  try {
    await copyFile(error.framePath, keptPath);
  } catch {
    throw error;
  }
  throw new CropNotConfirmedError(keptPath);
}

/**
 * Kalan adımların ihtiyacını tahmin eder ve boş alanla karşılaştırır.
 *
 * Montaj çıktısı ≈ base.mp4 × (müzik süresi / klip süresi) — gövde kopyalandığı
 * için tahmin gerçekçi. `extraBytes`: kalan adımların yazacağı ara ses dosyaları.
 */
async function checkDiskSpace({ dir, baseSize, baseDuration, targetDuration, copies, extraBytes = 0, diskFree }) {
  const videoBytes = baseSize * (targetDuration / baseDuration);
  const requiredBytes = Math.round((videoBytes * copies + extraBytes) * DISK_MARGIN.ratio + DISK_MARGIN.bytes);

  const freeBytes = await diskFree(dir);
  // --overwrite: eski çıktılar ancak rename anında serbest kalır, boş alana sayılmaz.
  if (freeBytes < requiredBytes) {
    throw new BuildError(
      `Disk yetersiz: ~${gb(requiredBytes)} GB gerekli, ${gb(freeBytes)} GB boş (${dir}).`,
    );
  }
  return { requiredBytes, freeBytes, estimatedVideoBytes: Math.round(videoBytes) };
}

/** @param {string} dir */
async function freeBytesOf(dir) {
  const fs = await statfs(dir);
  return fs.bavail * fs.bsize;
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

function gb(bytes) {
  return (bytes / 1e9).toFixed(2);
}

// ------------------------------------------------------------------- CLI

const USAGE = `Kullanım:
  node build.js [--project ./project.json] [seçenekler]

Seçenekler:
  --project <yol>     project.json yolu (varsayılan: ./project.json)
  --crop-bottom <N>   alttan kırpılacak piksel; konfigi ezer ve onay istenir
  --verify-crop       değer konfigde olsa da kontrol karesi göster, onay iste
  --aspect <W:H|off>  en-boy kırpması (varsayılan 16:9)
  --scale <genişlik>  base.mp4'ü bu genişliğe ölçekle (çift sayı)
  --render            uzun videoyu da üret (varsayılan: yalnızca yayın paketi)
  --stream-dir <yol|off>  yayın paketinin kopyalanacağı klasör; "off" yayına vermez
  --keep              workspace'i silme (ara dosyalar + loop testi kalır)
  --overwrite         çıktı varsa üzerine yaz
  -h, --help          bu metin`;

/**
 * Bayrakları loadProject'in anladığı biçime çevirir.
 * @param {string[]} argv
 */
export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      project: { type: 'string', default: './project.json' },
      'crop-bottom': { type: 'string' },
      'verify-crop': { type: 'boolean', default: false },
      aspect: { type: 'string' },
      'stream-dir': { type: 'string' },
      scale: { type: 'string' },
      render: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      overwrite: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const toNumber = (value) => (value === undefined ? undefined : Number(value));

  return {
    help: values.help,
    project: values.project,
    render: values.render,
    keep: values.keep,
    overwrite: values.overwrite,
    overrides: {
      cropBottom: toNumber(values['crop-bottom']),
      verifyCrop: values['verify-crop'],
      aspect: values.aspect,
      // "off" → yayına verme, paket yalnızca out/ altına yazılsın.
      streamDir: values['stream-dir'] === undefined
        ? undefined
        : (values['stream-dir'] === 'off' ? null : values['stream-dir']),
      scaleWidth: toNumber(values.scale),
    },
  };
}

/** Terminalde e/h sorusu. Ctrl+C soruda "hayır" sayılır. */
async function askConfirm({ framePath, cropBottom, before, after }) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      `\n  Kontrol karesi: ${framePath}\n` +
      `  Kırpma: alttan ${cropBottom} px, ${before.width}×${before.height} → ${after.width}×${after.height}`,
    );
    const answer = await Promise.race([
      rl.question('  Kareye baktın mı, kırpma doğru mu? [e/H] '),
      new Promise((resolveAnswer) => rl.once('SIGINT', () => resolveAnswer(''))),
    ]);
    return /^(e|evet|y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function consoleUi() {
  const tty = Boolean(process.stdout.isTTY);
  let progressShown = false;

  const clearProgress = () => {
    if (progressShown) {
      process.stdout.write('\r\x1b[2K');
      progressShown = false;
    }
  };

  const loggerFor = (tag) => ({
    info: (message) => { clearProgress(); console.log(`[${tag}] ${message}`); },
    warn: (message) => { clearProgress(); console.warn(`[${tag}] UYARI: ${message}`); },
  });

  const onProgress = tty
    ? (tag, seconds, total) => {
      const done = formatClock(seconds);
      const text = total
        ? `[${tag}] ${done} / ${formatClock(total)}  %${Math.min(100, Math.floor((seconds / total) * 100))}`
        : `[${tag}] ${done}`;
      process.stdout.write(`\r\x1b[2K${text}`);
      progressShown = true;
    }
    : undefined;

  return { loggerFor, onProgress, clearProgress };
}

function formatClock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * CLI girişi. Çıkış kodları: 0 başarı · 1 build hatası · 2 kullanım/konfig hatası ·
 * 130 iptal (Ctrl+C).
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }

  const ui = consoleUi();

  let config;
  try {
    config = await loadProject(cli.project, cli.overrides);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }

  // Ctrl+C: ilkinde ffmpeg'leri durdur ve temizliğe izin ver, ikincisinde hemen çık.
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    ui.clearProgress();
    console.error('\nİptal ediliyor — çalışan ffmpeg durduruluyor, workspace temizlenecek. ' +
      '(Beklemeden çıkmak için tekrar Ctrl+C)');
    controller.abort();
    abortAll();
  };
  process.on('SIGINT', onSigint);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  try {
    const report = await runBuild(config, {
      loggerFor: ui.loggerFor,
      onProgress: ui.onProgress,
      confirm: interactive ? askConfirm : undefined,
      overwrite: cli.overwrite,
      render: cli.render,
      keep: cli.keep,
      signal: controller.signal,
    });
    ui.clearProgress();
    // Render'sız çalışmada video/tracklist yok; üretilenleri raporun kendisi söyler.
    const produced = Object.values(report.outputs).map((path) => `  ${path}`);
    console.log(
      `\nBitti (${formatClock(report.totalSeconds)} dk):\n` +
      [...produced, `  ${config.output.report}`].join('\n') +
      (report.streamPackage?.published
        ? `\nYayın tarafına alındı: ${report.streamPackage.published} ` +
          `(${report.streamPackage.trackCount} parça, ${gb(report.streamPackage.totalBytes)} GB)`
        : '') +
      (report.warnings.length ? `\n${report.warnings.length} uyarı — raporda.` : ''),
    );
    return 0;
  } catch (error) {
    ui.clearProgress();
    if (controller.signal.aborted) {
      console.error(new BuildCancelledError().message);
      return 130;
    }
    // Pomodoro doğrulaması: hiçbir şey üretilmedi, konfig hatasıyla aynı sınıf.
    // Çıkış kodu 2 → server/build-jobs.js bunu "config-invalid" olarak etiketler.
    if (error instanceof PomodoroValidationError) {
      console.error(
        `\nPomodoro doğrulaması başarısız — montaj başlatılmadı.\n\n${error.message}`,
      );
      return 2;
    }
    if (error instanceof CropNotConfirmedError && !interactive) {
      console.error(
        `${error.message}\n(Terminal etkileşimli değil, onay sorulamadı. Değeri project.json'a ` +
        'yaz ya da komutu terminalden çalıştır.)',
      );
      return 1;
    }
    console.error(`\nBuild başarısız: ${error.message}`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
