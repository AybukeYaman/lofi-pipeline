/**
 * project.json — okuma, doğrulama, yol çözümleme, bayraklarla birleştirme.
 *
 * Tek sorumluluk: build'in ihtiyaç duyduğu, doğrulanmış ve mutlak yollu tek bir
 * nesne üretmek. Hiçbir medya işlemi yapmaz, dosyaya yazmaz — kullanıcının
 * konfigi değiştirilmez (HANDOFF bölüm 15, Aşama 5 karar 2).
 *
 * Bütün hatalar toplanıp TEK seferde raporlanır: düzelt-çalıştır-sıradaki hata
 * döngüsüne düşülmesin.
 */

import { stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { normalizeAmbientSelection } from './ambient-plan.js';
import { AspectError, parseAspect } from './aspect.js';
import { normalizePomodoroSelection } from './pomodoro-plan.js';
import { IMAGE_EXTENSIONS, isImagePath } from './files.js';
import { readJsonFile } from './workspace.js';

export class ConfigError extends Error {
  /**
   * @param {string} path
   * @param {string[]} problems
   */
  constructor(path, problems) {
    super(`project.json geçersiz (${path}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'ConfigError';
    this.path = path;
    this.problems = problems;
  }
}

/** Varsayılanlar — prep/project-status.js çıktı yolunu aynı değerlerle bulur. */
export const CONFIG_DEFAULTS = {
  video: { source: 'clip', aspect: '16:9', crf: 21, preset: 'slow', fadeOut: 5, crossfadeSeconds: 0 },
  audio: { bitrate: '192k', ambientOffsetDb: -18.8 },
  output: { dir: './out', name: 'final_ambient.mp4', tracklist: 'tracklist.txt' },
};

/**
 * Görsel kaynağı: `clip` = döngü video (.mp4), `image` = tüm video boyunca tek resim.
 * `image` modunda `clip` alanı bir görseli gösterir.
 */
export const VIDEO_SOURCES = ['clip', 'image'];

/**
 * 24/7 yayın sisteminin albüm kökü. Yayın paketi buraya yazılır — yayın
 * tarafının BAŞKA hiçbir dosyasına dokunulmaz (`prep/ambients.js`
 * DEFAULT_AMBIENT_DIR ile aynı mantık: makineye özel ortak klasör).
 *
 * `stream.dir: null` verilirse paket yalnızca projenin `out/` klasörüne yazılır.
 */
export const DEFAULT_STREAM_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\YT Stream System\\music-source';

/** Bilinen anahtarlar — yazım hatası ("cropbottom") sessizce yok sayılmasın. */
const KNOWN_KEYS = {
  root: ['clip', 'audioDir', 'ambient', 'pomodoro', 'stream', 'order', 'names', 'video', 'audio', 'output', 'music', 'style', 'styleBlock', 'motionHints', 'workflow'],
  video: ['source', 'cropBottom', 'cropTop', 'cropLeft', 'cropRight', 'watermark', 'aspect', 'crf', 'preset', 'fadeOut', 'scaleWidth', 'crossfadeSeconds'],
  audio: ['bitrate', 'ambientOffsetDb'],
  output: ['dir', 'name', 'tracklist'],
  stream: ['enabled', 'dir', 'album'],
};

/**
 * project.json'u okur, bayraklarla birleştirir, doğrular.
 *
 * @param {string} projectPath
 * @param {{
 *   cropBottom?: number, verifyCrop?: boolean, aspect?: string|null,
 *   scaleWidth?: number,
 * }} [overrides] CLI bayrakları — konfigi ezer
 * @returns {Promise<object>} çözümlenmiş konfig
 */
export async function loadProject(projectPath, overrides = {}) {
  const path = resolve(projectPath);
  let json;
  try {
    json = await readJsonFile(path);
  } catch (cause) {
    throw new ConfigError(path, [
      cause instanceof SyntaxError
        ? `JSON ayrıştırılamadı: ${cause.message}`
        : `dosya okunamadı: ${cause.code ?? cause.message}`,
    ]);
  }

  return resolveProject(json, { projectPath: path, overrides });
}

/**
 * Ayrıştırılmış JSON'dan çözümlenmiş konfig. Dosya varlığı da burada denetlenir.
 *
 * @param {object} json
 * @param {{ projectPath: string, overrides?: object }} context
 */
async function resolveProject(json, { projectPath, overrides = {} }) {
  const problems = [];
  const warnings = [];
  const baseDir = dirname(projectPath);
  const at = (p) => (isAbsolute(p) ? p : resolve(baseDir, p));

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ConfigError(projectPath, ['kök bir nesne olmalı: { "clip": ..., ... }']);
  }

  const video = objectOrEmpty(json.video, 'video', problems);
  const audio = objectOrEmpty(json.audio, 'audio', problems);
  const output = objectOrEmpty(json.output, 'output', problems);

  unknownKeys(json, KNOWN_KEYS.root, '', warnings);
  unknownKeys(video, KNOWN_KEYS.video, 'video.', warnings);
  unknownKeys(audio, KNOWN_KEYS.audio, 'audio.', warnings);
  unknownKeys(output, KNOWN_KEYS.output, 'output.', warnings);

  // --- yollar
  // Boş metin çözülmez: "" proje klasörüne çözülüp ikinci, yanıltıcı bir
  // "dosya değil" hatası üretiyordu (new-video.js clip'i boş yazar).
  const clip = requireString(json.clip, 'clip', problems) ? at(json.clip) : null;
  const audioDir = requireString(json.audioDir, 'audioDir', problems) ? at(json.audioDir) : null;
  // Ambiance: şekil çözümlemesi core/ambient-plan.js'te (tek metin, metin
  // dizisi ve { mode, tracks } nesnesi aynı plana çıkar). Burada yalnızca
  // yollar mutlaklaştırılıp dosyaların varlığı doğrulanır.
  const { plan: ambientPlan, problems: ambientProblems } = normalizeAmbientSelection(json.ambient);
  problems.push(...ambientProblems);
  let ambient = null;
  if (ambientPlan) {
    const tracks = [];
    for (let i = 0; i < ambientPlan.tracks.length; i++) {
      const track = ambientPlan.tracks[i];
      const resolved = at(track.path);
      await expectKind(resolved, 'file', `ambient[${i}]`, problems);
      tracks.push({ ...track, path: resolved });
    }
    ambient = { ...ambientPlan, tracks };
  }

  // Pomodoro: şekil çözümlemesi core/pomodoro-plan.js'te (preset, tur sayısı,
  // cue ayarları). Burada yalnızca verilmiş cue dosyalarının yolu mutlaklaştırılıp
  // varlığı doğrulanır — yol verilmemiş cue'lar ffmpeg'in sine kaynağıyla üretilir.
  const { plan: pomodoroPlan, problems: pomodoroProblems } = normalizePomodoroSelection(json.pomodoro);
  problems.push(...pomodoroProblems);
  let pomodoro = null;
  if (pomodoroPlan) {
    const cue = { ...pomodoroPlan.cue };
    for (const key of ['beepFile', 'workStartFile', 'breakStartFile']) {
      if (cue[key] === null) continue;
      cue[key] = at(cue[key]);
      await expectKind(cue[key], 'file', `pomodoro.cue.${key}`, problems);
    }
    pomodoro = { ...pomodoroPlan, cue };
  }

  // --- yayın paketi: 24/7 yayının albümü (render'dan bağımsız, varsayılan açık)
  const streamBlock = objectOrEmpty(json.stream, 'stream', problems);
  unknownKeys(streamBlock, KNOWN_KEYS.stream, 'stream.', warnings);
  const streamEnabled = streamBlock.enabled ?? true;
  if (typeof streamEnabled !== 'boolean') {
    problems.push(`stream.enabled: true ya da false olmalı (verilen: ${JSON.stringify(streamBlock.enabled)})`);
  }
  // null → paket yalnızca out/ altına yazılır (yayın tarafına kopyalanmaz).
  const streamDir = streamBlock.dir === undefined ? DEFAULT_STREAM_DIR : streamBlock.dir;
  if (streamDir !== null && typeof streamDir !== 'string') {
    problems.push(`stream.dir: klasör yolu ya da null olmalı (verilen: ${JSON.stringify(streamDir)})`);
  }
  // Albüm adı yayında görünür; verilmezse proje klasörünün adı kullanılır.
  const streamAlbum = streamBlock.album ?? basename(baseDir);
  if (typeof streamAlbum !== 'string' || streamAlbum.trim() === '') {
    problems.push(`stream.album: boş olmayan bir ad olmalı (verilen: ${JSON.stringify(streamBlock.album)})`);
  }

  if (clip) await expectKind(clip, 'file', 'clip', problems);

  // --- görsel kaynağı: klip ile tür uyuşmazlığı build'den önce yakalanır
  const source = video.source ?? CONFIG_DEFAULTS.video.source;
  if (!VIDEO_SOURCES.includes(source)) {
    problems.push(`video.source: ${VIDEO_SOURCES.map((v) => `"${v}"`).join(' ya da ')} olmalı (verilen: ${JSON.stringify(source)})`);
  } else if (clip && source === 'image' && !isImagePath(clip)) {
    problems.push(`clip: video.source "image" iken görsel olmalı (${IMAGE_EXTENSIONS.join(', ')}): ${clip}`);
  } else if (clip && source === 'clip' && isImagePath(clip)) {
    problems.push(`clip: görsel verilmiş ama video.source "clip" — tek resim için video.source: "image" yaz: ${clip}`);
  }
  if (audioDir) await expectKind(audioDir, 'directory', 'audioDir', problems);

  // --- sıra ve adlar
  if (json.order !== undefined && !(
    Array.isArray(json.order) && json.order.every((x) => typeof x === 'string' && x.trim())
  )) {
    problems.push('order: boş olmayan metinlerden oluşan bir dizi olmalı');
  }
  if (json.names !== undefined && !(
    json.names && typeof json.names === 'object' && !Array.isArray(json.names) &&
    Object.values(json.names).every((x) => typeof x === 'string')
  )) {
    problems.push('names: { "dosya-adı": "Görünen Ad" } biçiminde bir nesne olmalı');
  }

  // --- kırpma: bayrak konfigi ezer; ezilen değer konfigden gelmemiş sayılır
  const configCrop = video.cropBottom;
  if (configCrop !== undefined) nonNegativeInt(configCrop, 'video.cropBottom', problems);
  if (video.cropTop !== undefined) nonNegativeInt(video.cropTop, 'video.cropTop', problems);
  if (video.cropLeft !== undefined) nonNegativeInt(video.cropLeft, 'video.cropLeft', problems);
  if (video.cropRight !== undefined) nonNegativeInt(video.cropRight, 'video.cropRight', problems);

  const cropFromFlag = overrides.cropBottom !== undefined;
  if (cropFromFlag) nonNegativeInt(overrides.cropBottom, '--crop-bottom', problems);

  const cropBottom = cropFromFlag ? overrides.cropBottom : (configCrop ?? 0);
  if (cropBottom === undefined && video.cropTop === undefined && video.cropLeft === undefined && video.cropRight === undefined) {
    problems.push(
      'kırpma değeri yok: project.json\'da "video.cropBottom" ya da --crop-bottom N ' +
      'bayrağı gerekli (değer uydurulmaz; bayrakla verilen değer için kontrol karesi onayı istenir)',
    );
  }

  // --- en-boy: "off" / null → kapalı
  const aspectInput = overrides.aspect !== undefined
    ? overrides.aspect
    : (video.aspect !== undefined ? video.aspect : CONFIG_DEFAULTS.video.aspect);
  let aspect = null;
  if (aspectInput !== null && aspectInput !== 'off' && aspectInput !== false) {
    try {
      aspect = parseAspect(aspectInput).label;
    } catch (error) {
      if (!(error instanceof AspectError)) throw error;
      problems.push(`aspect: ${error.message} — kapatmak için "off"`);
    }
  }

  // --- sayılar
  const crf = video.crf ?? CONFIG_DEFAULTS.video.crf;
  numberInRange(crf, 'video.crf', 0, 51, problems);
  const fadeOut = video.fadeOut ?? CONFIG_DEFAULTS.video.fadeOut;
  numberInRange(fadeOut, 'video.fadeOut', 0, 600, problems);
  // Üst sınır klibe bağlı (yarısı); o denetim klip ölçülünce 01'de yapılır.
  const crossfadeSeconds = video.crossfadeSeconds ?? CONFIG_DEFAULTS.video.crossfadeSeconds;
  numberInRange(crossfadeSeconds, 'video.crossfadeSeconds', 0, 60, problems);
  const scaleWidth = overrides.scaleWidth ?? video.scaleWidth;
  if (scaleWidth !== undefined) {
    if (!Number.isInteger(scaleWidth) || scaleWidth <= 0 || scaleWidth % 2 !== 0) {
      problems.push(`scaleWidth: pozitif çift tam sayı olmalı (verilen: ${scaleWidth})`);
    }
  }
  const preset = video.preset ?? CONFIG_DEFAULTS.video.preset;
  requireString(preset, 'video.preset', problems);

  const bitrate = audio.bitrate ?? CONFIG_DEFAULTS.audio.bitrate;
  if (typeof bitrate !== 'string' || !/^\d+k$/.test(bitrate)) {
    problems.push(`audio.bitrate: "192k" biçiminde olmalı (verilen: ${JSON.stringify(bitrate)})`);
  }
  const ambientOffsetDb = audio.ambientOffsetDb ?? CONFIG_DEFAULTS.audio.ambientOffsetDb;
  numberInRange(ambientOffsetDb, 'audio.ambientOffsetDb', -60, 0, problems);

  // --- çıktı
  const outDir = output.dir ?? CONFIG_DEFAULTS.output.dir;
  const outName = output.name ?? CONFIG_DEFAULTS.output.name;
  const tracklistName = output.tracklist ?? CONFIG_DEFAULTS.output.tracklist;
  requireString(outDir, 'output.dir', problems);
  for (const [value, key] of [[outName, 'output.name'], [tracklistName, 'output.tracklist']]) {
    if (requireString(value, key, problems) && /[\\/]/.test(value)) {
      problems.push(`${key}: klasör değil yalın dosya adı olmalı (verilen: ${value})`);
    }
  }

  if (problems.length > 0) throw new ConfigError(projectPath, problems);

  const outputDir = at(outDir);
  return {
    projectPath,
    clip,
    audioDir,
    ambient,
    pomodoro,
    stream: {
      enabled: streamEnabled,
      dir: streamDir === null ? null : at(streamDir),
      album: streamAlbum,
    },
    order: json.order ?? null,
    names: json.names ?? {},
    video: {
      source,
      cropBottom,
      cropTop: video.cropTop ?? 0,
      cropLeft: video.cropLeft ?? 0,
      cropRight: video.cropRight ?? 0,
      cropFromConfig: !cropFromFlag,
      verifyCrop: Boolean(overrides.verifyCrop),
      aspect,
      crf,
      preset,
      fadeOut,
      crossfadeSeconds,
      scaleWidth: scaleWidth ?? null,
    },
    audio: { bitrate, ambientOffsetDb },
    output: {
      dir: outputDir,
      video: resolve(outputDir, outName),
      tracklist: resolve(outputDir, tracklistName),
      report: resolve(outputDir, `${outName.replace(/\.[^.]+$/, '')}.report.json`),
      // Pomodoro açıkken WORK/BREAK dökümü buraya yazılır (kapalıyken üretilmez).
      pomodoroTimeline: resolve(outputDir, 'pomodoro-timeline.txt'),
      // Yayın paketinin projedeki kopyası (yayın tarafına ayrıca yazılır).
      streamPackage: resolve(outputDir, 'stream-package'),
    },
    warnings,
  };
}

// ---------------------------------------------------------------- yardımcılar

function objectOrEmpty(value, key, problems) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${key}: nesne olmalı`);
    return {};
  }
  return value;
}

function unknownKeys(object, known, prefix, warnings) {
  for (const key of Object.keys(object)) {
    if (!known.includes(key)) {
      warnings.push(`Bilinmeyen anahtar yok sayıldı: "${prefix}${key}" (yazım hatası olabilir)`);
    }
  }
}

/** @returns {boolean} geçerliyse true */
function requireString(value, key, problems) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: boş olmayan bir metin olmalı${value === undefined ? ' (eksik)' : ''}`);
    return false;
  }
  return true;
}

function nonNegativeInt(value, key, problems) {
  if (!Number.isInteger(value) || value < 0) {
    problems.push(`${key}: sıfır ya da pozitif tam sayı olmalı (verilen: ${JSON.stringify(value)})`);
  }
}

function numberInRange(value, key, min, max, problems) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    problems.push(`${key}: ${min} ile ${max} arasında sayı olmalı (verilen: ${JSON.stringify(value)})`);
  }
}

async function expectKind(path, kind, key, problems) {
  try {
    const info = await stat(path);
    const ok = kind === 'file' ? info.isFile() : info.isDirectory();
    if (!ok) problems.push(`${key}: ${kind === 'file' ? 'dosya' : 'klasör'} değil: ${path}`);
  } catch {
    problems.push(`${key}: bulunamadı: ${path}`);
  }
}
