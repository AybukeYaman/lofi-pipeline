/**
 * project.json'a hedefli yazım — `clip`, görsel kaynağı, Ambiance seçimi,
 * Pomodoro ayarı, müzik durumu, watermark kırpması.
 *
 * build.js konfigi hiç değiştirmez (Aşama 5 kararı 2); clip'i yazan panel.
 * Diğer anahtarların değeri ve sırası korunur, dosya 2 boşluk girintiyle
 * BOM'suz yeniden yazılır (elle verilmiş özel biçim kaybolur).
 */

import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { normalizeAmbientSelection, serializeAmbientPlan } from '../core/ambient-plan.js';
import { CONFIG_DEFAULTS, VIDEO_SOURCES } from '../core/config.js';
import { isImagePath } from '../core/files.js';
import {
  SYSTEM_LABEL_KINDS, createLabel, normalizeLabelPlan, serializeLabelPlan,
} from '../core/label-plan.js';
import { normalizePomodoroSelection, serializePomodoroPlan } from '../core/pomodoro-plan.js';
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
 * Bir dosyanın hangi görsel kaynağı moduna denk geldiği: görsel uzantısı →
 * `image`, gerisi → `clip`. Modun `clip` alanıyla ayrı düşmemesi bu tek
 * kurala bağlı — core/config.js ikisi uyuşmazsa build'i reddediyor.
 *
 * @param {string} clipPath
 * @returns {'clip'|'image'}
 */
export function videoSourceForClip(clipPath) {
  return isImagePath(clipPath) ? 'image' : 'clip';
}

/** project.json'daki etkin `video.source` — anahtar yoksa/geçersizse varsayılan. */
function currentVideoSource(json) {
  const video = json.video;
  const source = video !== null && typeof video === 'object' && !Array.isArray(video)
    ? video.source
    : undefined;
  return VIDEO_SOURCES.includes(source) ? source : CONFIG_DEFAULTS.video.source;
}

/** `video` bloğunu nesne olarak verir; başka türse hata. */
function videoBlock(json) {
  const video = json.video === undefined ? {} : json.video;
  if (video === null || typeof video !== 'object' || Array.isArray(video)) {
    throw new ProjectFileError('project.json "video" bir nesne olmalı');
  }
  return video;
}

/**
 * `clip` alanını yazar. Klip proje klasörünün içinde ve var olmalı; göreli
 * `./videolar/in.mp4` biçiminde yazılır (proje klasörü taşınsa da çalışır).
 *
 * `video.source` seçilen dosyanın türünden TÜRETİLİR: görsel seçilince `image`,
 * video seçilince `clip` yazılır. Kullanıcı fikrini değiştirip resimden videoya
 * (ya da tersine) geçtiğinde iki alanın ayrı düşüp build'i kilitlemesi böyle
 * engelleniyor. Etkin kaynak zaten doğruysa anahtar EKLENMEZ — varsayılana
 * güvenen konfigler olduğu gibi kalır.
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

  const source = videoSourceForClip(target);
  if (source !== currentVideoSource(json)) {
    json.video = { ...videoBlock(json), source };
  }

  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json.clip;
}

/**
 * `video.source` yazar — "fikrimi değiştirdim, bu videoyu resimden değil
 * klipten kurmak istiyorum" işlemi.
 *
 * Yeni moda uymayan `clip` değeri boşaltılır (silinmez, `""` olur: seçim
 * ekranları o alanı bekliyor). Kırpma değerlerine DOKUNULMAZ — watermark payı
 * kullanıcının ölçümü, mod değişti diye sıfırlanmaz; gözden geçirilmesi
 * gerekiyorsa uyarı döner. Montaj çıktısı da silinmez: build zaten base.mp4'ü
 * her çalışmada baştan üretiyor.
 *
 * @param {string} projectPath
 * @param {'clip'|'image'} source
 * @returns {Promise<{
 *   source: 'clip'|'image', previous: 'clip'|'image', changed: boolean,
 *   clearedClip: string|null, warnings: string[],
 * }>}
 */
export async function setVideoSource(projectPath, source) {
  if (!VIDEO_SOURCES.includes(source)) {
    throw new ProjectFileError(
      `video.source ${VIDEO_SOURCES.map((v) => `"${v}"`).join(' ya da ')} olmalı: ${JSON.stringify(source)}`,
    );
  }

  const json = await readProjectObject(projectPath);
  const previous = currentVideoSource(json);
  const video = videoBlock(json);

  if (previous === source) {
    return { source, previous, changed: false, clearedClip: null, warnings: [] };
  }

  const warnings = [];
  let clearedClip = null;

  // Seçili dosya yeni moda uymuyorsa alanı boşalt: bırakılsa core/config.js
  // "clip: video.source ... olmalı" diyip build'i reddederdi ve kullanıcı
  // project.json'u elle düzeltmek zorunda kalırdı — çözülen şey tam buydu.
  const clip = typeof json.clip === 'string' ? json.clip.trim() : '';
  if (clip !== '' && videoSourceForClip(clip) !== source) {
    clearedClip = json.clip;
    json.clip = '';
    warnings.push(
      source === 'image'
        ? `Seçili klip (${clearedClip}) bir video, tek resim modunda kullanılamaz — seçim boşaltıldı, resimler\\ altından görsel seç.`
        : `Seçili görsel (${clearedClip}) tek resim, klip modunda kullanılamaz — seçim boşaltıldı, videolar\\ altından .mp4 seç.`,
    );
  }

  const cropBottom = video.cropBottom;
  if (Number.isSafeInteger(cropBottom) && cropBottom > 0) {
    warnings.push(
      source === 'image'
        ? `video.cropBottom ${cropBottom} olarak kaldı: görselde watermark olmaz, alttan kırpma istemiyorsan 0 yap.`
        : `video.cropBottom ${cropBottom} olarak kaldı: yeni klibin watermark payı farklıysa kırpmayı yeniden ölç.`,
    );
  } else if (source === 'clip') {
    warnings.push(
      `video.cropBottom ayarlı değil: klipte watermark varsa alttan ~${DEFAULT_CROP_BOTTOM} px kırpma gerekir.`,
    );
  }

  json.video = { ...video, source };
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return { source, previous, changed: true, clearedClip, warnings };
}

/**
 * Ambiance seçimini yazar — "arka planda hangi ortam sesleri çalsın".
 *
 * Proje kurulurken verilen seçim artık her an değişebiliyor: `new-video.js`
 * ilk seçimi yazıyor, bu fonksiyon sonrasını. Dosyaya yazılan şekil
 * `core/ambient-plan.js` `serializeAmbientPlan`'den gelir — tek parça +
 * varsayılan ayar yine `"ambient": "..."` olarak kalır, eski projelerin
 * dosyası şişmez.
 *
 * Yollar proje klasörüne göre DEĞİL mutlak yazılır: Ambiance'lar albümlerin
 * paylaştığı ortak klasörde duruyor (`prep/ambients.js` DEFAULT_AMBIENT_DIR),
 * proje klasörünün içinde değil.
 *
 * @param {string} projectPath
 * @param {{ path: string, volumeDb?: number|null }[]} tracks
 *   seçilen Ambiance'lar, çalma/katman sırasıyla; boş dizi seçimi kaldırır
 * @param {{ mode?: string, crossfade?: number, volumeDb?: number|null }} [settings]
 * @returns {Promise<{ ambient: unknown, plan: object|null, warnings: string[] }>}
 */
export async function setProjectAmbient(projectPath, tracks, settings = {}) {
  const selection = tracks.length === 0
    ? undefined
    : {
      ...(settings.mode === undefined ? {} : { mode: settings.mode }),
      ...(settings.crossfade === undefined ? {} : { crossfade: settings.crossfade }),
      ...(settings.volumeDb === undefined || settings.volumeDb === null
        ? {} : { volumeDb: settings.volumeDb }),
      tracks: tracks.map((track) =>
        track.volumeDb === undefined || track.volumeDb === null
          ? track.path
          : { path: track.path, volumeDb: track.volumeDb }),
    };

  const { plan, problems } = normalizeAmbientSelection(selection);
  if (problems.length > 0) {
    throw new ProjectFileError(`Ambiance seçimi geçersiz:\n  - ${problems.join('\n  - ')}`);
  }

  const json = await readProjectObject(projectPath);
  const ambient = serializeAmbientPlan(plan);

  // Seçim kaldırıldıysa anahtar tamamen silinir: `"ambient": null` bırakılsa
  // core/config.js onu "ambient yok" saysa da dosyada anlamsız bir artık
  // kalırdı ve kullanıcı seçim var mı yok mu ayırt edemezdi.
  if (ambient === undefined) delete json.ambient;
  else json.ambient = ambient;

  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');

  const warnings = [];
  if (plan === null) {
    warnings.push('Ambiance seçimi kaldırıldı — montajda arka plan sesi olmayacak.');
  }

  return { ambient: ambient ?? null, plan, warnings };
}

/**
 * Video üstü etiketleri yazar (`labels` dizisi — core/label-plan.js).
 *
 * Yalnızca GÖRSEL durumu (konum, boyut, renk, serbest metin) saklanır; zaman ve
 * Pomodoro durumu `pomodoro` bloğunda kalır, buradan değişmez. Boş liste anahtarı
 * tamamen siler: `labels` yoksa sistem bugünkü gibi çalışır (ambient ile aynı kural).
 *
 * @param {string} projectPath
 * @param {object[]} rawLabels API gövdesi ya da normalleştirilmiş etiketler
 * @returns {Promise<{ labels: object[], warnings: string[] }>}
 */
export async function setProjectLabels(projectPath, rawLabels) {
  const { labels, problems, warnings } = normalizeLabelPlan(rawLabels);
  if (problems.length > 0) {
    throw new ProjectFileError(`Etiketler geçersiz:\n  - ${problems.join('\n  - ')}`);
  }

  const json = await readProjectObject(projectPath);
  if (labels.length === 0) delete json.labels;
  else json.labels = serializeLabelPlan(labels);

  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return { labels, warnings };
}

/**
 * Pomodoro ayarını yazar — "bu video Pomodoro oturumları olarak kurulsun".
 *
 * Ambiance ile aynı kural: yazılan şekil `core/pomodoro-plan.js`
 * `serializePomodoroPlan`'den gelir, varsayılandan sapmayan alan dosyaya
 * yazılmaz. Mod kapatıldığında anahtar tamamen silinir — `"enabled": false`
 * bırakmak, kullanıcının dosyada "açık mı kapalı mı" diye bakacağı anlamsız
 * bir artık olurdu; kapalı Pomodoro bugünkü sistemin ta kendisi.
 *
 * @param {string} projectPath
 * @param {object|null} settings `{ enabled, preset?, workMinutes?, breakMinutes?,
 *   rounds?, countdownSeconds?, countdownBeep?,
 *   trimExcess?, cue? }` — null ya da `enabled: false` seçimi kaldırır
 * @returns {Promise<{ pomodoro: object|null, plan: object|null, warnings: string[] }>}
 */
export async function setProjectPomodoro(projectPath, settings) {
  const { plan, problems } = normalizePomodoroSelection(
    settings === null ? undefined : settings,
  );
  if (problems.length > 0) {
    throw new ProjectFileError(`Pomodoro ayarı geçersiz:\n  - ${problems.join('\n  - ')}`);
  }

  // Mola görüntüsü: proje klasörünün içinde var olan bir resim/klip. Yol `./videolar/x.mp4`
  // biçimine çevrilir (setProjectClip ile aynı) — build göreli yolu proje klasörüne çözüyor.
  if (plan !== null && plan.breakClip !== null) {
    plan.breakClip = await resolveBreakClip(projectPath, plan.breakClip);
  }

  const json = await readProjectObject(projectPath);
  const written = serializePomodoroPlan(plan);
  // Kapalıydı, şimdi açılıyor: STUDY/BREAK yazısı ve sayaç kendiliğinden gelsin. Yalnızca
  // KAPALI → AÇIK geçişinde: kullanıcı yazıyı bilerek sildiyse ayar değişince geri gelmesin.
  const turnedOn = plan !== null && json.pomodoro?.enabled !== true;
  if (written === undefined) delete json.pomodoro;
  else json.pomodoro = written;

  const warnings = [];
  if (turnedOn && addPomodoroLabels(json)) {
    warnings.push('Ekrana çalışma/mola yazısı ve kalan süre sayacı eklendi — yerini 4. adımdan değiştirebilirsin.');
  }

  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');

  if (plan === null) {
    warnings.push('Pomodoro kapatıldı — montaj bugünkü düz akışla çalışacak.');
  }

  return { pomodoro: written ?? null, plan, warnings };
}

/**
 * Eksik sistem etiketlerini (STUDY/BREAK + sayaç) varsayılan yerlerine ekler.
 * Mevcut etiketler bozuksa dokunmaz: elle yazılmış bir kaydı ezmektense hiç eklememek.
 *
 * @param {object} json project.json nesnesi (yerinde değişir)
 * @returns {boolean} bir şey eklendi mi
 */
function addPomodoroLabels(json) {
  const { labels, problems } = normalizeLabelPlan(json.labels);
  if (problems.length > 0) return false;

  let added = false;
  for (const kind of SYSTEM_LABEL_KINDS) {
    if (labels.some((label) => label.kind === kind)) continue;
    labels.push(createLabel(labels, { kind }));
    added = true;
  }
  if (added) json.labels = serializeLabelPlan(labels);
  return added;
}

/** Mola görüntüsü uzantıları: döngü videosu ya da resim (core/config.js ile aynı iki tür). */
const BREAK_CLIP_VIDEO_EXTENSION = '.mp4';

async function resolveBreakClip(projectPath, breakClip) {
  const dir = dirname(resolve(projectPath));
  const target = resolve(dir, breakClip);
  const rel = relative(dir, target);

  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ProjectFileError(`Mola görüntüsü proje klasörünün içinde olmalı: ${target}`);
  }
  if (!isImagePath(target) && !target.toLowerCase().endsWith(BREAK_CLIP_VIDEO_EXTENSION)) {
    throw new ProjectFileError(`Mola görüntüsü resim ya da .mp4 olmalı: ${target}`);
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new ProjectFileError(`Mola görüntüsü bulunamadı: ${target}`);
  return `./${rel.split(sep).join('/')}`;
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
  json.video = { ...videoBlock(json), cropBottom };
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
export async function setProjectCrop(projectPath, { cropTop, cropBottom = 0, cropLeft, cropRight, aspect } = {}) {
  for (const [key, val] of Object.entries({ cropTop, cropBottom, cropLeft, cropRight })) {
    if (val !== undefined && (!Number.isSafeInteger(val) || val < 0)) {
      throw new ProjectFileError(`video.${key} sıfır ya da pozitif tam sayı olmalı: ${JSON.stringify(val)}`);
    }
  }
  const json = await readProjectObject(projectPath);
  const nextVideo = { ...videoBlock(json), cropBottom };
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
  if (aspect !== undefined) {
    if (aspect) nextVideo.aspect = aspect;
    else delete nextVideo.aspect;
  }
  json.video = nextVideo;
  await writeTextFile(projectPath, JSON.stringify(json, null, 2) + '\n');
  return json.video;
}

/** project.json'u okur; kök nesne değilse ProjectFileError. */
/**
 * project.json'u nesne olarak okur; hatayı ProjectFileError'a sarar.
 * `prep/shorts-file.js` de bunu kullanıyor — aynı okuma/hata metni iki
 * yerde ayrı yazılmasın.
 */
export async function readProjectObject(projectPath) {
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
