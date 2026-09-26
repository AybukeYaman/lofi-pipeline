/**
 * Aşama 6 — Regresyon: gerçek albümle tek komut build, test/baseline.json ile karşılaştırma.
 *
 *   LOFI_ALBUM_DIR="C:\...\A Quiet Afternoon with a Book & Coffee" node test/regression.js
 *   LOFI_ALBUM_DIR="…" node test/regression.js --update     # baseline'ı yeniden üret
 *
 * `LOFI_ALBUM_DIR` yoksa atlanır (npm test'in parçası değil: build ~3 dk + ölçüm, 3+ GB geçici alan).
 *
 * Ne karşılaştırılır:
 *   - Deterministik değerler BİREBİR: parça süreleri, damgalar, montaj planı, kare sayısı,
 *     çözünürlük, kırpma filtresi, tracklist metni.
 *   - Ölçümler toleransla: süre (DURATION_TOLERANCE), dosya boyutu, LUFS, ayrıştırılmış ambient,
 *     kare parlaklık/renk ortalamaları, loop SSIM.
 *   - Süreler (adım saniyeleri) yalnızca raporlanır — makine yüküne bağlı (bkz. HANDOFF bölüm 15 notu).
 *
 * Ambient AYNI build'in workspace'inde ayrıştırılır (`--keep`): final_mix_0.wav − mix.wav.
 * Yayınlanan videoya karşı ayrıştırma geçersiz: montaj sesi yeniden encode eder, müzik
 * konumu ms'lerce kayar ve çıkarma müziği silmez (ölçüldü: −10.8 / −12.4 LUFS "ambient").
 *
 * Album parmak izi (dosya adları + MD5) baseline'da tutulur: albüm değişirse karşılaştırma
 * anlamsızdır, test en başta açık bir mesajla durur.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { ffmpeg } from '../core/ffmpeg.js';
import { md5File } from '../core/files.js';
import { probe } from '../core/probe.js';
import { countFrames } from './helpers/fixtures.js';
import { assertAlbumUnchanged, CHECKS, TOLERANCE } from './helpers/regression-compare.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(REPO, 'test', 'baseline.json');
const ALBUM = process.env.LOFI_ALBUM_DIR;
const UPDATE = process.argv.includes('--update');

/** Baseline yokken kullanılan konfig. Yollar albüm klasörüne göre. Değiştirmek için baseline.config düzenlenip --update. */
const DEFAULT_CONFIG = {
  clip: 'videolar/in.mp4',
  audioDir: 'audio',
  ambient: 'ses effektleri/campfire.mp3',
  order: [
    'midnight-window', 'midnight-street', 'midnight-city-pulse', 'nocturnal-groove',
    'nocturnal-isolation', 'rain-on-the-glass', 'quiet-room-echoes', 'silent-space',
    'somnambule', 'midnight-comfort', 'quiet-nightfall', 'bittersweet-motif', '2',
    'sunrise-quiet', 'morning-light',
  ],
  names: { 2: 'Before Light' },
  video: { cropBottom: 150, aspect: '16:9', crf: 16, preset: 'slow', fadeOut: 5, crossfadeSeconds: 0 },
  audio: { bitrate: '192k', ambientOffsetDb: -18.8 },
};

/** Ambient ayrıştırma kesitleri (sn): albümün ortası ve en sessiz noktası (Somnambule). */
const AMBIENT_SEGMENTS = [600, 1612];
/** Görüntü kontrol anları (sn): gövde ortası ve fade içi. */
const FRAME_TIMES = [300, 2884];

// ------------------------------------------------------------------ ölçümler

async function fingerprintAlbum(config) {
  const audioDir = join(ALBUM, config.audioDir);
  const audio = [];
  for (const name of (await readdir(audioDir)).sort()) {
    audio.push({ name, md5: await md5File(join(audioDir, name)) });
  }
  return {
    clip: { path: config.clip, md5: await md5File(join(ALBUM, config.clip)) },
    ambient: config.ambient
      ? { path: config.ambient, md5: await md5File(join(ALBUM, config.ambient)) }
      : null,
    audio,
  };
}

async function loudness(path) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', '-i', path, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { fullStderr: true });
  const s = stderr.slice(stderr.lastIndexOf('Summary:'));
  return {
    integratedLufs: Number(/I:\s*(-?[\d.]+) LUFS/.exec(s)[1]),
    rangeLu: Number(/LRA:\s*(-?[\d.]+) LU/.exec(s)[1]),
    truePeakDb: Number(/Peak:\s*(-?[\d.]+) dBFS/.exec(s)[1]),
  };
}

/** Karışımdan aynı build'in ambientsiz sesini çıkar; kalan ambient'in LUFS'u. */
async function isolatedAmbient(mixed, dry, start) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info',
    '-ss', String(start), '-t', '30', '-i', mixed,
    '-ss', String(start), '-t', '30', '-i', dry,
    '-filter_complex', '[1:a]volume=-1[n];[0:a][n]amix=inputs=2:weights=1 1:normalize=0,ebur128',
    '-f', 'null', '-',
  ], { fullStderr: true });
  return Number(/I:\s*(-?[\d.]+) LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary:')))[1]);
}

/** Karenin Y/U/V ortalamaları (0–255). Kadraj, fade ve renk kaymasını yakalar. */
async function frameAverages(path, seconds) {
  const { stderr } = await ffmpeg([
    '-loglevel', 'info', '-ss', String(seconds), '-i', path, '-frames:v', '1',
    '-vf', 'signalstats,metadata=print', '-f', 'null', '-',
  ], { fullStderr: true });
  const read = (key) => Number(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`).exec(stderr)[1]);
  return { Y: read('YAVG'), U: read('UAVG'), V: read('VAVG') };
}

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function tool(binary) {
  const r = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split('\n')[0].trim() : null;
}

/** Build'i CLI'dan çalıştırır ve tüm ölçümleri toplar. */
async function buildAndMeasure(config, workDir) {
  const project = {
    ...config,
    clip: join(ALBUM, config.clip),
    audioDir: join(ALBUM, config.audioDir),
    ...(config.ambient ? { ambient: join(ALBUM, config.ambient) } : {}),
    output: { dir: './out', name: 'final_ambient.mp4' },
  };
  const projectPath = join(workDir, 'project.json');
  await writeFile(projectPath, JSON.stringify(project, null, 2));

  const run = spawnSync(process.execPath, [join(REPO, 'build.js'), '--project', projectPath, '--keep'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`build.js çıkış ${run.status}\n${run.stderr}\n${run.stdout.slice(-2000)}`);
  }

  const out = join(workDir, 'out');
  const files = await readdir(out);
  const workspace = files.find((f) => f.startsWith('lofi-build-'));
  const report = JSON.parse(await readFile(join(out, 'final_ambient.report.json'), 'utf8'));
  const video = join(out, 'final_ambient.mp4');
  // Ambient ayrıştırması aynı zincirin iki sesi arasında: ambientli karışım
  // (final_mix_0.wav) − ambientsiz müzik (mix.wav). Montajın ek encode'u
  // araya girerse örnekler kayar ve müzik silinmez (ölçüldü: −10.8 "ambient").
  const dry = join(out, workspace, 'mix.wav');
  const wet = join(out, workspace, 'final_mix_0.wav');
  const d = report.details;
  const info = await probe(video);

  const measured = {
    outputs: files.filter((f) => f !== workspace).sort(),
    report: {
      stepOrder: report.steps.map((s) => s.tag),
      warnings: report.warnings.map((w) => w.message),
      sortSource: report.sortSource,
      ambient: report.ambient,
      musicDuration: report.musicDuration,
      tracks: d['02'].tracks.map((t) => ({
        file: basename(t.file), duration: t.duration, startSeconds: t.startSeconds,
      })),
      cropFilter: d['01'].aspect?.filter ?? null,
      base: { width: d['01'].result.width, height: d['01'].result.height, frames: Math.round(d['01'].result.duration * d['01'].result.fps) },
      loopSsim: d['01'].loop.ssim,
      assemble: {
        method: d['04'].method,
        plan: d['04'].plan,
        tailCompatible: d['04'].tail?.compatible ?? null,
        junctions: d['04'].junctions.map((j) => ({ kind: j.kind, clean: j.clean })),
      },
      ambientMix: d['03'] ? {
        musicI: d['03'].musicI,
        targetI: d['03'].ambientTargetI,
        verificationAmbientI: d['03'].verification?.ambientMeasuredI ?? null,
        verificationMixI: d['03'].verification?.mixI ?? null,
      } : null,
      tracklist: { count: d['05'].count, youtubeChapters: d['05'].youtubeChapters },
    },
    tracklistText: await readFile(join(out, 'tracklist.txt'), 'utf8'),
    output: {
      width: info.width, height: info.height, fps: Number(info.fps.toFixed(3)),
      videoCodec: info.videoCodec, audioCodec: info.audioCodec,
      sampleRate: info.sampleRate, channels: info.channels,
      duration: info.duration, frames: await countFrames(video), sizeBytes: info.size,
    },
    loudness: await loudness(video),
    ambientIsolatedLufs: {},
    frameAverages: {},
    stepSeconds: Object.fromEntries(report.steps.map((s) => [s.tag, s.seconds])),
    totalSeconds: report.totalSeconds,
  };
  if (d['03']) {
    for (const t of AMBIENT_SEGMENTS) measured.ambientIsolatedLufs[t] = await isolatedAmbient(wet, dry, t);
  }
  for (const t of FRAME_TIMES) measured.frameAverages[t] = await frameAverages(video, t);
  return measured;
}

// ------------------------------------------------------------------ testler
// Karşılaştırmalar test/helpers/regression-compare.js'te (build'siz sınanıyor).

describe('regresyon (gerçek albüm)', { skip: ALBUM ? false : 'LOFI_ALBUM_DIR tanımlı değil' }, () => {
  let workDir;
  let baseline;
  let config;
  let measured;

  before(async () => {
    baseline = existsSync(BASELINE_PATH) ? JSON.parse(await readFile(BASELINE_PATH, 'utf8')) : null;
    if (!baseline && !UPDATE) {
      throw new Error(`${BASELINE_PATH} yok — önce --update ile üret.`);
    }
    config = baseline?.config ?? DEFAULT_CONFIG;

    const fingerprint = await fingerprintAlbum(config);
    if (!UPDATE) assertAlbumUnchanged(fingerprint, baseline);

    workDir = await mkdtemp(join(tmpdir(), 'lofi-regression-'));
    measured = await buildAndMeasure(config, workDir);

    if (UPDATE) {
      const dirty = git(['status', '--porcelain']);
      const next = {
        generated: {
          at: new Date().toISOString(),
          by: 'node test/regression.js --update',
          commit: git(['rev-parse', 'HEAD']),
          commitSubject: git(['log', '-1', '--format=%s']),
          // Değişmiş dosyalar: baseline'ın hangi kodla üretildiğini tam söylemek için.
          uncommitted: dirty ? dirty.split('\n').map((l) => l.trim()) : [],
          node: process.version,
          ffmpeg: tool('ffmpeg'),
          platform: `${process.platform} ${process.arch}`,
          reference: baseline?.generated?.reference ?? null,
        },
        album: fingerprint,
        config,
        tolerance: TOLERANCE,
        expect: {
          outputs: measured.outputs,
          report: measured.report,
          tracklistText: measured.tracklistText,
          output: measured.output,
          loudness: measured.loudness,
          ambientIsolatedLufs: measured.ambientIsolatedLufs,
          frameAverages: measured.frameAverages,
        },
        timing: { stepSeconds: measured.stepSeconds, totalSeconds: measured.totalSeconds, note: 'bilgi amaçlı, karşılaştırılmaz' },
      };
      await writeFile(BASELINE_PATH, JSON.stringify(next, null, 2) + '\n');
      baseline = next;
    }
  });

  after(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  for (const check of CHECKS) {
    test(check.name, () => check.run(measured, baseline));
  }

  test('süreler (bilgi)', (t) => {
    const before = baseline.timing?.stepSeconds ?? {};
    const rows = [...Object.entries(measured.stepSeconds), ['toplam', measured.totalSeconds]];
    for (const [tag, now] of rows) {
      const was = tag === 'toplam' ? baseline.timing?.totalSeconds : before[tag];
      const delta = Number.isFinite(was) ? ` (${now - was >= 0 ? '+' : ''}${(now - was).toFixed(1)})` : '';
      t.diagnostic(`${tag.padEnd(6)} baseline ${String(was ?? '—').padStart(6)} sn → şimdi ${String(now).padStart(6)} sn${delta}`);
    }
    if (UPDATE) t.diagnostic(`baseline yazıldı: ${BASELINE_PATH}`);
  });
});
