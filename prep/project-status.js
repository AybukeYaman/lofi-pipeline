/**
 * Proje durumu — klasöre bakıp "sıradaki adım ne?" sorusunu yanıtlar.
 *
 * Tek sorumluluk: okumak ve karar vermek. Hiçbir dosya yazmaz, komut
 * çalıştırmaz, durum saklamaz — her seferinde diskten okunur, böylece
 * dosyalar elle taşınsa da doğru adım bulunur (Aşama 8 kararı).
 *
 * inspectProject (okuma) ile nextStep (saf karar) ayrı: karar tablosu
 * dosya kurmadan test edilir.
 */

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { CONFIG_DEFAULTS } from '../core/config.js';
import { AUDIO_EXTENSIONS, listFiles } from '../core/files.js';
import { readJsonFile } from '../core/workspace.js';

/** Faz 1 çıktısı: resimler/MASTER.<uzantı>. Master1.jpg gibi açı varyantları sayılmaz. */
const MASTER_PATTERN = /^master\.[a-z0-9]+$/i;
const STYLE_REF_PATTERN = /^style-ref\.[a-z0-9]+$/i;

/** Sıralı modda "bu oturumda atla" denebilen adımlar — kanıt gerektirmeyen elle işler. */
export const SKIPPABLE_STEPS = ['faz1', 'faz3'];

/**
 * Proje klasörünün anlık durumu. Eksik klasörler hata değil, "boş" sayılır.
 *
 * @param {string} dir proje klasörü
 */
export async function inspectProject(dir) {
  const projectPath = join(dir, 'project.json');
  const projectJson = await readProjectJson(projectPath);
  const data = projectJson.data ?? {};
  const at = (p) => (isAbsolute(p) ? p : resolve(dir, p));

  const images = await fileNames(join(dir, 'resimler'));
  const master = images.find((n) => MASTER_PATTERN.test(n));
  const styleRef = images.find((n) => STYLE_REF_PATTERN.test(n));

  const clipValue = typeof data.clip === 'string' ? data.clip.trim() : '';
  const clipPath = clipValue ? at(clipValue) : null;

  const audioDir = at(nonEmpty(data.audioDir) ?? './audio');
  const output = data.output !== null && typeof data.output === 'object' ? data.output : {};
  const outputPath = resolve(
    at(nonEmpty(output.dir) ?? CONFIG_DEFAULTS.output.dir),
    nonEmpty(output.name) ?? CONFIG_DEFAULTS.output.name,
  );

  return {
    dir,
    projectPath,
    promptsPath: join(dir, 'prompts.md'),
    projectJson,
    master: master ? join(dir, 'resimler', master) : null,
    styleRef: styleRef ? join(dir, 'resimler', styleRef) : null,
    clips: await filesOrEmpty(join(dir, 'videolar'), ['.mp4']),
    clip: { value: clipValue, path: clipPath, exists: clipPath ? await isFile(clipPath) : false },
    audioDir,
    audioCount: (await filesOrEmpty(audioDir, AUDIO_EXTENSIONS)).length,
    output: { path: outputPath, exists: await isFile(outputPath) },
  };
}

/**
 * Sıradaki adım. Kanıta göre SONDAN BAŞA bakılır: çıktı varsa bitti, klip ve
 * müzik varsa montaj… Böylece elle yapılmış ama "işaretlenmemiş" adımlar
 * yeniden istenmez.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @param {{ skipped?: Set<string> }} [options] bu oturumda atlanan elle adımlar
 * @returns {{ id: string, kind: 'manual'|'auto'|'done', title: string, detail: string, skippable: boolean }}
 */
export function nextStep(s, { skipped = new Set() } = {}) {
  const step = (id, kind, title, detail) => ({ id, kind, title, detail, skippable: SKIPPABLE_STEPS.includes(id) });

  if (!s.projectJson.ok) {
    return step('fix-project', 'manual', 'project.json düzeltilmeli', `${s.projectPath}: ${s.projectJson.error}`);
  }
  if (s.output.exists) {
    return step('done', 'done', 'Video hazır', `Çıktı: ${s.output.path}`);
  }

  const missingClip = s.clip.value && !s.clip.exists ? `clip'teki dosya bulunamadı: ${s.clip.path}\n` : '';

  if (s.clip.exists) {
    if (s.audioCount > 0) {
      return step('build', 'auto', 'Montaj', `Klip: ${s.clip.value} · ${s.audioCount} parça\nÇıktı: ${s.output.path}`);
    }
    return step('audio', 'manual', 'Müzik (Suno)',
      `Suno parçalarını şu klasöre koy: ${s.audioDir}\n` +
      'Sıra için project.json\'a "order" eklenebilir; yoksa alfabetik sıralanır.');
  }

  if (s.clips.length > 0) {
    return step('clip', 'auto', 'Klibi seç', `${missingClip}videolar\\ altında ${s.clips.length} klip var — kullanılacak olanı seç.`);
  }

  if (!s.master && !skipped.has('faz1')) {
    return step('faz1', 'manual', 'Faz 1 — Master frame',
      `${missingClip}prompts.md → Faz 1 ile master frame'i üret, resimler\\MASTER.png olarak kaydet.\n` +
      (s.styleRef ? `Image 2 (stil referansı): ${s.styleRef}\n` : 'Stilin referans görseli yok — Image 2\'yi elle ekle.\n') +
      `Promptlar: ${s.promptsPath}`);
  }
  if (!skipped.has('faz3')) {
    return step('faz3', 'manual', 'Faz 3 — Klip (image-to-video)',
      `${missingClip}prompts.md → Faz 3 ile 5 sn'lik döngü klibini üret, videolar\\ altına .mp4 olarak koy.\n` +
      `(Faz 2 açı varyantları isteğe bağlı.) Promptlar: ${s.promptsPath}`);
  }
  return step('clip', 'manual', 'Klip bekleniyor', `${missingClip}videolar\\ altına klibi (.mp4) koy: ${join(s.dir, 'videolar')}`);
}

/**
 * Videolar kökündeki projeler (içinde project.json olan klasörler), son
 * değiştirilen en üstte. Değişim zamanı: klasör ya da project.json, hangisi
 * yeniyse (dosya eklemek klasörü, clip yazmak project.json'u günceller).
 *
 * @param {string} videosDir
 * @returns {Promise<{ name: string, dir: string, mtimeMs: number, step: ReturnType<typeof nextStep> }[]>}
 */
export async function listProjects(videosDir) {
  let entries;
  try {
    entries = await readdir(videosDir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }

  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(videosDir, entry.name);
    const projectInfo = await stat(join(dir, 'project.json')).catch(() => null);
    if (!projectInfo?.isFile()) continue;
    const dirInfo = await stat(dir);
    projects.push({
      name: entry.name,
      dir,
      mtimeMs: Math.max(dirInfo.mtimeMs, projectInfo.mtimeMs),
      step: nextStep(await inspectProject(dir)),
    });
  }
  return projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ---------------------------------------------------------------- yardımcılar

async function readProjectJson(path) {
  try {
    const data = await readJsonFile(path);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, data: null, error: 'kök bir nesne olmalı' };
    }
    return { ok: true, data, error: null };
  } catch (cause) {
    const error = cause.code === 'ENOENT'
      ? 'dosya yok'
      : cause instanceof SyntaxError ? `JSON ayrıştırılamadı: ${cause.message}` : `okunamadı: ${cause.code ?? cause.message}`;
    return { ok: false, data: null, error };
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

async function fileNames(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function filesOrEmpty(dir, extensions) {
  try {
    return await listFiles(dir, extensions);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
