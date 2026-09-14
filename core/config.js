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
import { dirname, isAbsolute, resolve } from 'node:path';

import { AspectError, parseAspect } from './aspect.js';
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
  video: { aspect: '16:9', crf: 16, preset: 'slow', fadeOut: 5, crossfadeSeconds: 0 },
  audio: { bitrate: '192k', ambientOffsetDb: -18.8 },
  output: { dir: './out', name: 'final_ambient.mp4', tracklist: 'tracklist.txt' },
};

/** Bilinen anahtarlar — yazım hatası ("cropbottom") sessizce yok sayılmasın. */
const KNOWN_KEYS = {
  root: ['clip', 'audioDir', 'ambient', 'order', 'names', 'video', 'audio', 'output'],
  video: ['cropBottom', 'aspect', 'crf', 'preset', 'fadeOut', 'scaleWidth', 'crossfadeSeconds'],
  audio: ['bitrate', 'ambientOffsetDb'],
  output: ['dir', 'name', 'tracklist'],
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
  const ambient = json.ambient !== undefined && requireString(json.ambient, 'ambient', problems)
    ? at(json.ambient)
    : null;

  if (clip) await expectKind(clip, 'file', 'clip', problems);
  if (audioDir) await expectKind(audioDir, 'directory', 'audioDir', problems);
  if (ambient) await expectKind(ambient, 'file', 'ambient', problems);

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
  const cropFromFlag = overrides.cropBottom !== undefined;
  if (cropFromFlag) nonNegativeInt(overrides.cropBottom, '--crop-bottom', problems);

  const cropBottom = cropFromFlag ? overrides.cropBottom : configCrop;
  if (cropBottom === undefined) {
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
    order: json.order ?? null,
    names: json.names ?? {},
    video: {
      cropBottom,
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
