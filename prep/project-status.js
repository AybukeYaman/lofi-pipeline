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
import { basename, isAbsolute, join, resolve } from 'node:path';

import { CONFIG_DEFAULTS } from '../core/config.js';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, isImagePath, listFiles } from '../core/files.js';
import { readJsonFile } from '../core/workspace.js';
import { CUSTOM_STYLE_NAME } from './styles.js';

/** Faz 1 çıktısı: resimler/MASTER.<uzantı>. Master1.jpg gibi açı varyantları sayılmaz. */
export const MASTER_PATTERN = /^master\.[a-z0-9]+$/i;
const STYLE_REF_PATTERN = /^style-ref\.[a-z0-9]+$/i;
/** Adım 3 (sahne referansı): resimler/scene-ref.<uzantı>. */
export const SCENE_REF_PATTERN = /^scene-ref\.[a-z0-9]+$/i;
/** Adım 5 (kamera açıları): resimler/Master1.jpg … — Faz 2 şablonunun adları. */
export const ANGLE_PATTERN = /^master(\d+)\.[a-z0-9]+$/i;

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
  const sceneRef = images.find((n) => SCENE_REF_PATTERN.test(n));
  const angles = images
    .filter((n) => ANGLE_PATTERN.test(n))
    .sort((a, b) => Number(ANGLE_PATTERN.exec(a)[1]) - Number(ANGLE_PATTERN.exec(b)[1]));

  const clipValue = typeof data.clip === 'string' ? data.clip.trim() : '';
  const clipPath = clipValue ? at(clipValue) : null;
  const clipExists = clipPath ? await isFile(clipPath) : false;

  // Görsel kaynağı (core/config.js VIDEO_SOURCES). Tek resim modunda klip
  // adayları resimler\ altındaki MASTER + açı varyantları: seçim, otomatik
  // bağlama ve web listesi iki modda da aynı `clips` listesiyle çalışır.
  const videoSource = data.video?.source === 'image' ? 'image' : 'clip';
  const masterPath = master ? join(dir, 'resimler', master) : null;
  const sceneRefPath = sceneRef ? join(dir, 'resimler', sceneRef) : null;
  const styleRefPath = styleRef ? join(dir, 'resimler', styleRef) : null;
  const anglePaths = angles.map((n) => join(dir, 'resimler', n));
  const clips = videoSource === 'image'
    ? [...(masterPath ? [masterPath] : []), ...anglePaths]
    : await filesOrEmpty(join(dir, 'videolar'), ['.mp4']);

  const audioDir = at(nonEmpty(data.audioDir) ?? './audio');
  const output = data.output !== null && typeof data.output === 'object' ? data.output : {};
  const outputDir = at(nonEmpty(output.dir) ?? CONFIG_DEFAULTS.output.dir);
  const outputPath = resolve(outputDir, nonEmpty(output.name) ?? CONFIG_DEFAULTS.output.name);
  const tracklistPath = resolve(outputDir, nonEmpty(output.tracklist) ?? CONFIG_DEFAULTS.output.tracklist);

  const references = await filesOrEmpty(join(dir, 'references'), IMAGE_EXTENSIONS);
  const styleBlockExists = await isFile(join(dir, 'STYLE_BLOCK.txt'));

  return {
    name: dir.split(/[\\/]/).pop(),
    dir,
    projectPath,
    promptsPath: join(dir, 'prompts.md'),
    styleBlockPath: join(dir, 'STYLE_BLOCK.txt'),
    styleBlockExists,
    references,
    projectJson,
    style: data.style || data.music?.style || '-',
    master: masterPath,
    styleRef: styleRefPath,
    sceneRef: sceneRefPath,
    angles: anglePaths,
    videoSource,
    clips,
    clip: { value: clipValue, path: clipPath, exists: clipExists },
    // Proje listesindeki küçük resim — kullanıcı seçmez: videoda görünen
    // görsel, yoksa master, yoksa sahne/stil referansı.
    thumbnail: (clipExists && isImagePath(clipPath) ? clipPath : null)
      ?? masterPath ?? sceneRefPath ?? styleRefPath,
    audioDir,
    audioCount: (await filesOrEmpty(audioDir, AUDIO_EXTENSIONS)).length,
    output: {
      path: outputPath,
      exists: await isFile(outputPath),
      tracklistPath,
      tracklistExists: await isFile(tracklistPath),
    },
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

  const isCustomStylePending = s.style === CUSTOM_STYLE_NAME && !s.styleBlockExists;
  if (isCustomStylePending) {
    return step('style-references', 'manual', 'Stil Referansı Bekleniyor',
      `Stil analizi için referans görsellerinizi şu klasöre koyun: ${join(s.dir, 'references')}\n` +
      `Desteklenen biçimler: ${IMAGE_EXTENSIONS.join(', ')} (${s.references.length} görsel bulundu)`);
  }

  if (!s.master && !skipped.has('faz1')) {
    return step('faz1', 'manual', 'Faz 1 — Master frame',
      `${missingClip}prompts.md → Faz 1 ile master frame'i üret, resimler\\MASTER.png olarak kaydet.\n` +
      `Promptlar: ${s.promptsPath}`);
  }

  const isStill = s.videoSource === 'image';

  // 10 Adımlı Akış: 6. Adım Video (Klip), 7. Adım Müzik'ten önce gelir!
  if (s.clips.length > 0 && !s.clip.exists) {
    return isStill
      ? step('clip', 'auto', 'Görseli seç', `${missingClip}resimler\\ altında ${s.clips.length} görsel var — video boyunca gösterilecek olanı seç.`)
      : step('clip', 'auto', 'Klibi seç', `${missingClip}videolar\\ altında ${s.clips.length} klip var — kullanılacak olanı seç.`);
  }

  // Tek resim: image-to-video (Faz 3) yok, video master görselinden üretilir.
  if (isStill && !s.clip.exists) {
    return step('clip', 'manual', 'Görsel bekleniyor', `${missingClip}Tek resim modu: resimler\\ altına MASTER.png koy: ${join(s.dir, 'resimler')}`);
  }

  if (!s.clip.exists && !skipped.has('faz3')) {
    return step('faz3', 'manual', 'Faz 3 — Klip (image-to-video)',
      `${missingClip}prompts.md → Faz 3 ile 5 sn'lik döngü klibini üret, videolar\\ altına .mp4 olarak koy.\n` +
      `(Faz 2 açı varyantları isteğe bağlı.) Promptlar: ${s.promptsPath}`);
  }

  if (!s.clip.exists) {
    return step('clip', 'manual', 'Klip bekleniyor', `${missingClip}videolar\\ altına klibi (.mp4) koy: ${join(s.dir, 'videolar')}`);
  }

  const musicCompleted = isMusicCompleted(s);

  if (!musicCompleted) {
    return step('audio', 'manual', 'Müzik (Suno)',
      `Suno parçalarını şu klasöre koy: ${s.audioDir}\n` +
      'Sıra için project.json\'a "order" eklenebilir; yoksa alfabetik sıralanır.');
  }

  if (s.clip.exists && musicCompleted) {
    return step('build', 'auto', 'Montaj', `Klip: ${s.clip.value} · ${s.audioCount} parça\nÇıktı: ${s.output.path}`);
  }

  return step('clip', 'manual', 'Klip bekleniyor', `${missingClip}videolar\\ altına klibi (.mp4) koy: ${join(s.dir, 'videolar')}`);
}

/**
 * Canonical kullanıcı akışı — 10 adım, sırası sabit. Her adımın "tamam"
 * olması yalnızca diskteki kanıttan (dosyalar + project.json) hesaplanır;
 * UI'nin son tıklanan durumu kullanılmaz. `current` ilk tamamlanmamış adım,
 * hepsi tamamsa `publish`.
 *
 * Eski projelerde kaydı olmayan adımlar sonraki adımın kanıtından çıkarılır:
 * master varsa sahne referansı, klip varsa açı kararı, çıktı varsa her şey.
 */
export const WORKFLOW_STEPS = [
  { id: 'project', title: 'Proje başlat', kind: 'manual', optional: false },
  { id: 'style', title: 'Stil görseli', kind: 'manual', optional: false },
  { id: 'reference', title: 'Referans görsel', kind: 'manual', optional: false },
  { id: 'master', title: 'Master Frame', kind: 'manual', optional: false },
  { id: 'angles', title: 'Kamera açıları', kind: 'manual', optional: true },
  { id: 'video', title: 'Video', kind: 'manual', optional: false },
  { id: 'music', title: 'Müzik', kind: 'manual', optional: false },
  { id: 'order', title: 'Sıralama', kind: 'manual', optional: false },
  { id: 'build', title: 'Montaj', kind: 'auto', optional: false },
  { id: 'publish', title: 'Yayın', kind: 'done', optional: false },
];

/**
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {{ current: string, currentTitle: string, steps: Array<typeof WORKFLOW_STEPS[number] & { number: number, status: 'done'|'current'|'pending', skipped: boolean }> }}
 */
export function canonicalWorkflow(s) {
  const data = s.projectJson.data ?? {};
  const workflow = isPlainObject(data.workflow) ? data.workflow : {};
  const angles = isPlainObject(workflow.angles) ? workflow.angles : null;
  const built = s.output.exists;
  const cropBottom = data.video?.cropBottom;
  const cropReady = Number.isSafeInteger(cropBottom) && cropBottom >= 0;
  const hasOrder = Array.isArray(data.order) && data.order.length > 0;
  // Tek resimde açı adımı sorulmaz (seçilen görsel yine bir açı varyantı olabilir).
  const isStill = s.videoSource === 'image';
  const anglesSkipped = isStill
    || angles?.wanted === false || (!angles && (s.clip.exists || built) && s.angles.length === 0);

  const done = {
    project: s.projectJson.ok,
    style: s.projectJson.ok && !(s.style === CUSTOM_STYLE_NAME && !s.styleBlockExists),
    reference: Boolean(s.sceneRef || s.master) || built,
    master: Boolean(s.master) || built,
    angles: isStill
      || angles?.wanted === false
      || (angles?.wanted === true && s.angles.length >= Math.max(1, Number(angles.count) || 1))
      || s.clip.exists || built,
    video: (s.clip.exists && cropReady) || built,
    music: isMusicCompleted(s) || built,
    order: hasOrder || built,
    build: built,
    publish: built,
  };

  const firstOpen = WORKFLOW_STEPS.find((step) => step.id !== 'publish' && !done[step.id]);
  const current = firstOpen?.id ?? 'publish';
  return {
    current,
    currentTitle: WORKFLOW_STEPS.find((step) => step.id === current).title,
    steps: WORKFLOW_STEPS.map((step, index) => ({
      ...step,
      number: index + 1,
      status: step.id === current ? 'current' : done[step.id] ? 'done' : 'pending',
      skipped: step.id === 'angles' && done.angles && anglesSkipped,
    })),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Müzik klasöründeki parçaların eklenme sırası (8. adım "Eklediğim sıra").
 * Kayıtlı olanlar (`workflow.audioAdded`) kayıt sırasıyla önce; kaydı olmayanlar
 * (ör. Explorer'dan elle konanlar) sonra, oluşturulma zamanına ve ada göre.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {Promise<string[]>} dosya adları
 */
export async function audioAddedOrder(s) {
  const paths = await filesOrEmpty(s.audioDir, AUDIO_EXTENSIONS);
  const workflow = s.projectJson.data?.workflow;
  const recorded = Array.isArray(workflow?.audioAdded) ? workflow.audioAdded : [];
  const names = paths.map((path) => basename(path));

  const known = recorded.filter((name, i) => names.includes(name) && recorded.indexOf(name) === i);
  const rest = [];
  for (const [i, name] of names.entries()) {
    if (known.includes(name)) continue;
    const info = await stat(paths[i]).catch(() => null);
    rest.push({ name, time: info?.birthtimeMs ?? 0 });
  }
  // Aynı zamanda oluşanlar klasörün doğal sırasında kalır (sort kararlı).
  rest.sort((a, b) => a.time - b.time);
  return [...known, ...rest.map((item) => item.name)];
}

/**
 * Müzik aşaması bitti mi? Parça planı varsa plan durumu (ya da tüm parçalar
 * tamam), yoksa audio klasöründe en az bir dosya. nextStep ile web API ortak
 * kullanır.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} s
 * @returns {boolean}
 */
export function isMusicCompleted(s) {
  const musicData = s.projectJson.data?.music;
  const isMultiTrack = musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0;
  return isMultiTrack
    ? (musicData.status === 'completed' || musicData.status === 'completed_by_user' || musicData.tracks.every((t) => t.status === 'completed'))
    : s.audioCount > 0;
}

/**
 * Videolar kökündeki projeler (içinde project.json olan klasörler), son
 * değiştirilen en üstte. Değişim zamanı: klasör ya da project.json, hangisi
 * yeniyse (dosya eklemek klasörü, clip yazmak project.json'u günceller).
 *
 * @param {string} videosDir
 * @returns {Promise<{ name: string, dir: string, mtimeMs: number, thumbnail: string|null, step: ReturnType<typeof nextStep> }[]>}
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
    const status = await inspectProject(dir);
    projects.push({
      name: entry.name,
      dir,
      mtimeMs: Math.max(dirInfo.mtimeMs, projectInfo.mtimeMs),
      thumbnail: status.thumbnail,
      step: nextStep(status),
      workflow: canonicalWorkflow(status),
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
