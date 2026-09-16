/**
 * project.json'a hedefli yazım — şimdilik yalnızca `clip`.
 *
 * build.js konfigi hiç değiştirmez (Aşama 5 kararı 2); clip'i yazan panel.
 * Diğer anahtarların değeri ve sırası korunur, dosya 2 boşluk girintiyle
 * BOM'suz yeniden yazılır (elle verilmiş özel biçim kaybolur).
 */

import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { readJsonFile, writeTextFile } from '../core/workspace.js';

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

  json.clip = `./${rel.split(sep).join('/')}`;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json.clip;
}

/**
 * project.json'daki her hangi bir alanı yazar.
 *
 * @param {string} projectPath
 * @param {string} key
 * @param {any} value
 */
export async function setProjectField(projectPath, key, value) {
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

  json[key] = value;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json[key];
}
