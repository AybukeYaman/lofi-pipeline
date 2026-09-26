/**
 * project.json'a hedefli yazım — `clip`, müzik durumu, watermark kırpması.
 *
 * build.js konfigi hiç değiştirmez (Aşama 5 kararı 2); clip'i yazan panel.
 * Diğer anahtarların değeri ve sırası korunur, dosya 2 boşluk girintiyle
 * BOM'suz yeniden yazılır (elle verilmiş özel biçim kaybolur).
 */

import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { readJsonFile, writeTextFile } from '../core/workspace.js';

/** Watermark kırpması — Hailuo'da ölçülen değer (HANDOFF bölüm 4). */
export const DEFAULT_CROP_BOTTOM = 150;

export class ProjectFileError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/**
 * `clip` alanını yazar. Klip proje klasörünün içinde ve var olmalı; göreli
 * `./videolar/in.mp4` biçiminde yazılır (proje klasörü taşınsa da çalışır).
 *
 * @param {string} projectPath
 * @param {string} clipPath mutlak ya da proje klasörüne göre göreli
 * @returns {Promise<string>} yazılan değer
 */
export async function setProjectClip(projectPath, clipPath) {
  const dir = dirname(resolve(projectPath));
  const target = resolve(dir, clipPath);
  const rel = relative(dir, target);

  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProjectFileError(`klip proje klasörünün içinde olmalı: ${target}`);
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new ProjectFileError(`klip dosyası bulunamadı: ${target}`);

  const json = await readProjectObject(projectPath);
  json.clip = `./${rel.split(sep).join('/')}`;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json.clip;
}

/**
 * "Müziği bitir ve devam et": eksik parçalar olsa da müzik aşaması kullanıcı
 * tarafından tamamlanmış sayılır. Parça planı (`music.tracks`) olan projeler
 * içindir; `musicData` yerinde güncellenir (panel ekranı aynı nesneyi kullanır).
 *
 * @param {string} projectPath
 * @param {{ tracks: { status: string }[], status?: string, completedCount?: number }} musicData
 * @returns {Promise<object>} yazılan music
 */
export async function completeMusicByUser(projectPath, musicData) {
  musicData.status = 'completed_by_user';
  musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
  return setProjectField(projectPath, 'music', musicData);
}

/**
 * Müzik klasörüne eklenen dosyaları eklenme sırasıyla `workflow.audioAdded`'a
 * yazar (8. adım "Eklediğim sıra"). Dosya tarihleri bunun yerine geçmez:
 * albümden kopyalanan parçalar aynı saniyede ve alfabetik sırayla oluşur.
 * Yeniden eklenen ad listenin sonuna taşınır. Build bu alanı okumaz.
 *
 * @param {string} projectPath
 * @param {string[]} names dosya adları (klasörsüz), eklenme sırasıyla
 * @returns {Promise<string[]>} güncel liste
 */
export async function recordAudioAdded(projectPath, names) {
  if (names.length === 0) return [];
  const json = await readProjectObject(projectPath);
  const workflow = json.workflow !== null && typeof json.workflow === 'object' && !Array.isArray(json.workflow)
    ? json.workflow
    : {};
  const previous = Array.isArray(workflow.audioAdded) ? workflow.audioAdded.filter((n) => typeof n === 'string') : [];
  const audioAdded = [...previous.filter((n) => !names.includes(n)), ...names];
  json.workflow = { ...workflow, audioAdded };
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return audioAdded;
}

/**
 * project.json'daki her hangi bir alanı yazar.
 *
 * @param {string} projectPath
 * @param {string} key
 * @param {any} value
 */
export async function setProjectField(projectPath, key, value) {
  const json = await readProjectObject(projectPath);
  json[key] = value;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json[key];
}

/**
 * Watermark kararı → `video.cropBottom`. Kapalı: 0. Açık: geçerli pozitif
 * değer korunur, yoksa ölçülen varsayılan.
 *
 * @param {boolean} watermark
 * @param {unknown} currentCrop project.json'daki mevcut değer
 * @returns {number}
 */
export function cropForWatermark(watermark, currentCrop) {
  if (!watermark) return 0;
  return Number.isSafeInteger(currentCrop) && currentCrop > 0 ? currentCrop : DEFAULT_CROP_BOTTOM;
}

/**
 * `video.cropBottom` yazar; `video` bloğunun diğer alanları korunur. Konfigden
 * gelen değer build.js'te onay istemez (core/config.js → cropFromConfig).
 *
 * @param {string} projectPath
 * @param {number} cropBottom sıfır ya da pozitif tam sayı
 * @returns {Promise<number>}
 */
export async function setProjectCropBottom(projectPath, cropBottom) {
  if (!Number.isSafeInteger(cropBottom) || cropBottom < 0) {
    throw new ProjectFileError(`video.cropBottom sıfır ya da pozitif tam sayı olmalı: ${JSON.stringify(cropBottom)}`);
  }
  const json = await readProjectObject(projectPath);
  const video = json.video === undefined ? {} : json.video;
  if (video === null || typeof video !== 'object' || Array.isArray(video)) {
    throw new ProjectFileError('project.json "video" bir nesne olmalı');
  }
  json.video = { ...video, cropBottom };
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return cropBottom;
}

/**
 * Çok yönlü kırpma (`cropTop`, `cropBottom`, `cropLeft`, `cropRight`, `watermark`) yazar.
 *
 * @param {string} projectPath
 * @param {{ cropTop?: number, cropBottom?: number, cropLeft?: number, cropRight?: number, watermark?: boolean }} options
 * @returns {Promise<object>}
 */
export async function setProjectCrop(projectPath, { cropTop, cropBottom = 0, cropLeft, cropRight } = {}) {
  for (const [key, val] of Object.entries({ cropTop, cropBottom, cropLeft, cropRight })) {
    if (val !== undefined && (!Number.isSafeInteger(val) || val < 0)) {
      throw new ProjectFileError(`video.${key} sıfır ya da pozitif tam sayı olmalı: ${JSON.stringify(val)}`);
    }
  }
  const json = await readProjectObject(projectPath);
  const video = json.video === undefined ? {} : json.video;
  if (video === null || typeof video !== 'object' || Array.isArray(video)) {
    throw new ProjectFileError('project.json "video" bir nesne olmalı');
  }
  const nextVideo = { ...video, cropBottom };
  if (cropTop !== undefined) {
    if (cropTop > 0) nextVideo.cropTop = cropTop;
    else delete nextVideo.cropTop;
  }
  if (cropLeft !== undefined) {
    if (cropLeft > 0) nextVideo.cropLeft = cropLeft;
    else delete nextVideo.cropLeft;
  }
  if (cropRight !== undefined) {
    if (cropRight > 0) nextVideo.cropRight = cropRight;
    else delete nextVideo.cropRight;
  }
  json.video = nextVideo;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json.video;
}

/** project.json'u okur; kök nesne değilse ProjectFileError. */
async function readProjectObject(projectPath) {
  let json;
  try {
    json = await readJsonFile(projectPath);
  } catch (cause) {
    throw new ProjectFileError(
      cause instanceof SyntaxError
        ? `project.json ayrıştırılamadı: ${cause.message}`
        : `project.json okunamadı: ${cause.code ?? cause.message}`,
    );
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new ProjectFileError('project.json kökü bir nesne olmalı');
  }
  return json;
}
