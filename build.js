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
 *   2  02-audio-concat  parçalar → mix.m4a, sonra disk kontrolü
 *   3  04-assemble      base × n + mix + fade → montaj
 *   4  03-ambient-mix   (opsiyonel) ambient → nihai video
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
import { createWorkspace, writeTextFile } from './core/workspace.js';
import { CropNotConfirmedError, prepareVideo } from './steps/01-video-prep.js';
import { concatAudio } from './steps/02-audio-concat.js';
import { mixAmbient } from './steps/03-ambient-mix.js';
import { assembleVideo } from './steps/04-assemble.js';
import { writeTracklist } from './steps/05-tracklist.js';

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
 * @param {boolean} [options.keep] workspace silinmez
 * @param {AbortSignal} [options.signal] adımlar arasında denetlenir
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
    keep = false,
    signal,
    diskFree = freeBytesOf,
  } = options;

  const log = loggerFor('build');
  const startedAt = Date.now();
  const steps = [];
  const warnings = config.warnings.map((message) => ({ step: 'config', message }));
  for (const w of config.warnings) log.warn(w);

  // --- 0: çıktı çakışması (hiçbir şey üretmeden)
  const targets = [config.output.video, config.output.tracklist];
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

  try {
    // --- 1: video hazırlığı (onay burada — ucuz, pahalı adımlardan önce)
    const video = await step('01', 'Video hazırlığı', (logger) => prepareVideo({
      clipPath: config.clip,
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
      outputPath: workspace.path('mix.m4a'),
      order: config.order ?? undefined,
      bitrate: config.audio.bitrate,
      logger,
      onProgress: progress('02', null),
    }));

    const disk = await checkDiskSpace({
      dir: config.output.dir,
      baseSize: video.result.size,
      baseDuration: video.result.duration,
      targetDuration: audio.duration,
      copies: config.ambient ? 2 : 1,
      diskFree,
    });
    log.info(
      `Disk: ~${gb(disk.requiredBytes)} GB gerekli, ${gb(disk.freeBytes)} GB boş.`,
    );

    // --- 3: montaj (04)
    // Workspace içindeki adlar sabit: çıktı adı ne olursa olsun girdiyle çakışmaz.
    const assembled = await step('04', 'Montaj', (logger) => assembleVideo({
      videoPath: video.output,
      audioPath: audio.output,
      outputPath: workspace.path('assembled.mp4'),
      workspace,
      fadeOut: config.video.fadeOut,
      crf: config.video.crf,
      preset: config.video.preset,
      bitrate: config.audio.bitrate,
      logger,
      onProgress: progress('04', audio.duration),
    }));

    // --- 4: ambient (03, opsiyonel)
    let finalVideo = assembled.output;
    if (config.ambient) {
      const ambientPaths = Array.isArray(config.ambient) ? config.ambient : [config.ambient];
      for (let i = 0; i < ambientPaths.length; i++) {
        const ambPath = ambientPaths[i];
        const stepName = ambientPaths.length > 1 ? `Ambient karıştırma (${i + 1}/${ambientPaths.length})` : 'Ambient karıştırma';
        const outPath = workspace.path(i === ambientPaths.length - 1 ? 'final.mp4' : `final_amb_${i}.mp4`);
        const mixed = await step('03', stepName, (logger) => mixAmbient({
          videoPath: finalVideo,
          ambientPath: ambPath,
          outputPath: outPath,
          workspace,
          ambientOffsetDb: config.audio.ambientOffsetDb,
          fadeOut: config.video.fadeOut,
          bitrate: config.audio.bitrate,
          logger,
          onProgress: progress('03', assembled.result.duration),
        }));
        finalVideo = mixed.output;
      }
    } else {
      log.info('Ambient tanımlı değil — adım atlandı, montaj çıktısı nihai dosya.');
    }

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

    const report = {
      project: config.projectPath,
      finishedAt: new Date().toISOString(),
      totalSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      outputs: {
        video: config.output.video,
        tracklist: config.output.tracklist,
        report: config.output.report,
      },
      musicDuration: audio.duration,
      sortSource: audio.sortSource,
      ambient: config.ambient ? 'mixed' : 'skipped',
      configLine,
      disk,
      settings: {
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
 * için tahmin gerçekçi. Ambient varsa zirvede iki video workspace'te aynı anda durur.
 */
async function checkDiskSpace({ dir, baseSize, baseDuration, targetDuration, copies, diskFree }) {
  const videoBytes = baseSize * (targetDuration / baseDuration);
  const requiredBytes = Math.round(videoBytes * copies * DISK_MARGIN.ratio + DISK_MARGIN.bytes);

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
      scale: { type: 'string' },
      keep: { type: 'boolean', default: false },
      overwrite: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const toNumber = (value) => (value === undefined ? undefined : Number(value));

  return {
    help: values.help,
    project: values.project,
    keep: values.keep,
    overwrite: values.overwrite,
    overrides: {
      cropBottom: toNumber(values['crop-bottom']),
      verifyCrop: values['verify-crop'],
      aspect: values.aspect,
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
      keep: cli.keep,
      signal: controller.signal,
    });
    ui.clearProgress();
    console.log(
      `\nBitti (${formatClock(report.totalSeconds)} dk):\n` +
      `  ${report.outputs.video}\n  ${report.outputs.tracklist}\n  ${report.outputs.report}` +
      (report.warnings.length ? `\n${report.warnings.length} uyarı — raporda.` : ''),
    );
    return 0;
  } catch (error) {
    ui.clearProgress();
    if (controller.signal.aborted) {
      console.error(new BuildCancelledError().message);
      return 130;
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
