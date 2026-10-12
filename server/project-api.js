/**
 * Web UI icin proje durum adapter'i.
 *
 * HTTP katmani filesystem ayrintilarini bilmez; mevcut proje-durum
 * fonksiyonlarini bu dar arayuzden kullanir. Yazan islemler panelin
 * prep/ altindaki domain fonksiyonlarini cagirir.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  AMBIENT_MODES, DEFAULT_AMBIENT_MODE, DEFAULT_CROSSFADE_SECONDS, normalizeAmbientSelection,
} from '../core/ambient-plan.js';
import { CONFIG_DEFAULTS, VIDEO_SOURCES } from '../core/config.js';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, imageMimeType, listFiles, uniqueFileName } from '../core/files.js';
import { normalizeLabelPlan } from '../core/label-plan.js';
import {
  POMODORO_DEFAULTS, POMODORO_PRESETS, buildTimeline, normalizePomodoroSelection, validatePomodoro,
} from '../core/pomodoro-plan.js';
import { probe } from '../core/probe.js';
import { moveDirToTrash, moveFileToTrash } from '../core/trash.js';
import { readJsonFile, writeTextFile } from '../core/workspace.js';
import { NewVideoError, runNewVideo } from '../new-video.js';
import { AmbientError, DEFAULT_AMBIENT_DIR, findAmbient, listAmbients } from '../prep/ambients.js';
import {
  DEFAULT_CROP_BOTTOM, ProjectFileError, completeMusicByUser, cropForWatermark, recordAudioAdded, setProjectAmbient, setProjectClip, setProjectCrop,
  setProjectCropBottom, setProjectField, setProjectLabels, setProjectPomodoro, setVideoSource,
} from '../prep/project-file.js';
import {
  audioAddedOrder, inspectProject, isMusicCompleted, projectWorkflow,
  listProjects, nextStep, orderedAudioTracks,
} from '../prep/project-status.js';
import { DEFAULT_VIDEOS_DIR, ProjectExistsError, validateVideoName } from '../prep/scaffold.js';

/** Albümdeki parça sayısı sınırı — music-planner ile aynı aralık. */
const MAX_TRACKS = 50;
const MAX_CONCEPT_LENGTH = 300;
/** 8. adım sıralama yöntemleri — project.json `workflow.order`. */
const TRACK_ORDER_MODES = ['alphabetical', 'added', 'manual'];
/**
 * Önizlenebilen asset türleri: projedeki izinli dosyalar (inspectProject'ten)
 * ve türün sunabileceği MIME ailesi (ör. MASTER.txt master olarak sunulmaz).
 */
const ASSET_TYPES = {
  /** Seçili klip; tek resim modunda (video.source = "image") bir görsel. */
  clip: { kind: ['video/', 'image/'], files: (status) => (status.clip.exists ? [status.clip.path] : []) },
  /** Seçim ekranı: selectClip'in kabul ettiği adaylar — videolar/*.mp4 ya da tek resim modunda resimler/ altındaki görseller */
  video: { kind: ['video/', 'image/'], files: (status) => status.clips },
  /** Proje listesindeki küçük resim (inspectProject seçer). */
  thumbnail: { kind: 'image/', files: (status) => (status.thumbnail ? [status.thumbnail] : []) },
  /** Müzik: audioDir'deki ses dosyaları (inspectProject'in audioCount'u ile aynı liste). */
  audio: { kind: 'audio/', files: (status) => audioFilesOf(status) },
  output: { kind: 'video/', files: (status) => (status.output.exists ? [status.output.path] : []) },
  tracklist: {
    kind: 'text/',
    files: (status) => (status.output.tracklistExists ? [status.output.tracklistPath] : []),
  },
};
const ASSET_MIME_TYPES = {
  ...Object.fromEntries(IMAGE_EXTENSIONS.map((ext) => [ext, imageMimeType(ext)])),
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
};
/** Yüklenen görsel (master, açı) üst sınırı. */
const MAX_IMAGE_SIZE_BYTES = 15 * 1024 * 1024;

export class InvalidProjectIdError extends Error {
  constructor() {
    super('Invalid project id');
    this.name = 'InvalidProjectIdError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found');
    this.name = 'ProjectNotFoundError';
  }
}

/** HTTP durum koduyla eslenen istek hatasi (400, 409, 422). */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {object} [details] yanitta `error` yanina eklenir
   */
  constructor(status, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

/** Mevcut proje klasorlerini UI'nin liste gorunumune uyarlar. */
export async function getProjects({ videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projects = await listProjects(videosDir);
  return projects.map(({ name, parentId, kind, mtimeMs, thumbnail, step, workflow }) => ({
    id: name,
    name,
    parentId: parentId ?? null,
    /** 'shorts' alt projesi kendi ekranını açar (web Dashboard/Workspace). */
    kind: kind ?? 'video',
    mtimeMs,
    thumbnailUrl: thumbnail ? assetUrl(name, 'thumbnail', basename(thumbnail)) : null,
    step,
    workflow,
  }));
}

/** Bir projenin diskten okunmus mevcut durumunu dondurur. */
export async function getProject(id, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  const readiness = describeReadiness(status);
  readiness.output = await describeOutput(id, projectDir, status);
  return {
    id,
    ...status,
    step: nextStep(status),
    workflow: projectWorkflow(status),
    readiness,
  };
}

/**
 * Yeni proje — panelin kullandigi runNewVideo (new-video.js) ile.
 *
 * @param {unknown} body `{ name, ambient?, videoSource?, concept?, totalTracks? }`
 * @returns {Promise<{ project: object, warnings: string[] }>}
 */
export async function createProject(body, {
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  runNewVideoFn = runNewVideo,
} = {}) {
  const input = parseCreateBody(body);
  // Panel gibi: isim geçerliyse klasörü önceden kontrol et — müzik planı
  // (GEMINI_API_KEY varsa ağ isteği) boşuna üretilmesin. Yarışı writeProject yakalar.
  if (validateVideoName(input.name).length === 0 && await exists(join(videosDir, input.name))) {
    throw new ApiError(409, 'Project already exists');
  }

  // Pomodoro düzeni klasör kurulmadan ÖNCE doğrulanır: geçersiz bir seçim yarım proje bırakmasın.
  if (input.pomodoro) {
    const { problems } = normalizePomodoroSelection(input.pomodoro);
    if (problems.length > 0) throw new ApiError(422, 'Project could not be created', { problems });
  }

  let parentDir = null;
  if (input.parentId) {
    try {
      parentDir = await resolveProjectDir(input.parentId, videosDir);
    } catch {
      throw new ApiError(404, `Parent project "${input.parentId}" not found`);
    }
  }

  let result;
  try {
    result = await runNewVideoFn({
      videoName: input.name,
      ambientName: input.ambient.length > 0 ? input.ambient : undefined,
      videoSource: input.videoSource,
      concept: input.concept,
      totalTracks: input.totalTracks,
      parentId: input.parentId,
      aspect: input.aspect,
      videosDir,
      ambientDir,
    });
  } catch (error) {
    if (error instanceof NewVideoError) {
      throw new ApiError(422, 'Project could not be created', { problems: error.problems });
    }
    if (error instanceof ProjectExistsError) {
      throw new ApiError(409, 'Project already exists');
    }
    throw error;
  }

  // "Ambiance mı, Pomodoro mu?" sorusunun cevabı: Pomodoro seçildiyse düzen proje
  // kurulurken yazılır (tek karar noktası setProjectPomodoro, sonradan da aynısı
  // değiştirir). Ambiance'ta hiçbir şey yazılmaz — proje bugünkü gibi kalır.
  if (input.pomodoro) {
    try {
      await setProjectPomodoro(join(videosDir, input.name, 'project.json'), input.pomodoro);
    } catch (error) {
      if (!(error instanceof ProjectFileError)) throw error;
      throw new ApiError(422, 'Project was created but Pomodoro settings are invalid', {
        problems: [error.message],
      });
    }
  }

  // Kopyalama mantığı copyTracksFromProject'te: kopyalama + audioAdded kaydı +
  // müzik planındaki pending parçaların işaretlenmesi tek yerde kalsın. Hata
  // yutulur (eskiden de öyleydi): müzik kopyalanamadı diye proje kurulumu bozulmaz.
  if (parentDir && Array.isArray(input.selectedTracks) && input.selectedTracks.length > 0) {
    try {
      await copyTracksFromProject(
        input.name,
        { sourceProjectId: input.parentId, trackFiles: input.selectedTracks },
        { videosDir },
      );
    } catch {
      // yoksayılır
    }
  }

  return {
    project: await getProject(input.name, { videosDir }),
    warnings: result.warnings,
  };
}

/**
 * Ana projeden veya başka bir projeden müzik parçalarını hedef projeye kopyalar.
 */
export async function copyTracksFromProject(targetId, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const input = parseBody(
    body,
    { sourceProjectId: 'string', trackFiles: 'array' },
    ['sourceProjectId', 'trackFiles']
  );
  const trackFiles = input.trackFiles;
  if (!Array.isArray(trackFiles) || trackFiles.length === 0) {
    throw new ApiError(400, 'trackFiles must be a non-empty array of file names');
  }

  const sourceDir = await resolveProjectDir(input.sourceProjectId, videosDir);
  const targetDir = await resolveProjectDir(targetId, videosDir);

  const sourceStatus = await inspectProject(sourceDir);
  const targetStatus = await inspectProject(targetDir);

  const sourceAudioFiles = await listFiles(sourceStatus.audioDir, AUDIO_EXTENSIONS).catch(() => []);
  const matchingPaths = sourceAudioFiles.filter((p) => trackFiles.includes(basename(p)));

  if (matchingPaths.length === 0) {
    throw new ApiError(422, 'No matching audio files found in source project');
  }

  await mkdir(targetStatus.audioDir, { recursive: true });
  const copiedFiles = [];
  for (const srcPath of matchingPaths) {
    const originalName = basename(srcPath);
    const destName = await uniqueFileName(targetStatus.audioDir, originalName);
    const destPath = join(targetStatus.audioDir, destName);
    await copyFile(srcPath, destPath);
    copiedFiles.push(destName);
  }
  await recordAudioAdded(targetStatus.projectPath, copiedFiles);

  const musicData = targetStatus.projectJson.data?.music;
  if (musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
    const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
    const count = Math.min(copiedFiles.length, pendingTracks.length);
    for (let i = 0; i < count; i++) {
      pendingTracks[i].status = 'completed';
      pendingTracks[i].file = copiedFiles[i];
    }
    musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
    musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
    await setProjectField(targetStatus.projectPath, 'music', musicData);
  }

  return {
    ok: true,
    copiedCount: copiedFiles.length,
    copiedFiles,
  };
}

/**
 * Ortak Ambiance kütüphanesi — Ambiance ekranının ve seçicilerin verisi.
 *
 * Eskiden burada müzik stilleri de dönüyordu; stil kavramı kaldırıldı
 * (stil kütüphanesi, `project.json` `style` alanı ve /api/styles uçları).
 */
export async function getLibrary({ ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  let ambients = [];
  let ambientError = null;
  try {
    ambients = await listAmbients(ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    ambientError = error.message;
  }

  return {
    ambients: ambients.map((ambient) => ({ name: ambient.name })),
    ambientError,
  };
}

/**
 * Klip secimi — panelin chooseClip'i gibi setProjectClip ile. Istemci yalnizca
 * projenin videolar\ klasorunde bulunan bir dosya adini secebilir.
 *
 * @param {unknown} body `{ file }`
 */
export async function selectClip(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { file } = parseBody(body, { file: 'string' }, ['file']);

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }
  const clip = status.clips.find((path) => basename(path) === file);
  if (!clip || !(await realPathInside(projectDir, clip))) {
    throw new ApiError(422, 'Clip not found in the project videolar folder', {
      available: status.clips.map((path) => basename(path)),
    });
  }

  try {
    await setProjectClip(status.projectPath, clip);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(422, error.message);
  }
  return getProject(id, { videosDir });
}

/**
 * Gorsel kaynagini degistirir (`clip` <-> `image`) — "resimden yapmistim,
 * videodan yapmak istiyorum". Panelin switchVideoSource'u ile ayni yazici.
 *
 * Yeni moda uymayan `clip` degeri setVideoSource tarafindan bosaltilir; ne
 * yapildigi `videoSourceChange` altinda doner (istemci uyarilari gosterir).
 *
 * @param {unknown} body `{ source: 'clip' | 'image' }`
 */
export async function updateVideoSource(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { source } = parseBody(body, { source: 'string' }, ['source']);
  if (!VIDEO_SOURCES.includes(source)) {
    throw new ApiError(400, `source must be one of: ${VIDEO_SOURCES.join(', ')}`);
  }

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }

  let change;
  try {
    change = await setVideoSource(status.projectPath, source);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(422, error.message);
  }

  return { ...await getProject(id, { videosDir }), videoSourceChange: change };
}

/**
 * Ortak Ambiance klasorune ses yukler.
 *
 * Ambiance'lar projeye degil ALBUMLERIN PAYLASTIGI klasore yaziliyor
 * (prep/ambients.js DEFAULT_AMBIENT_DIR): bir kez eklenen yagmur sesi butun
 * projelerden secilebilsin. Bu yuzden proje yuklemelerinin aksine burada
 * proje kimligi yok.
 *
 * Ayni adli dosya varsa 409 doner — sessizce uzerine yazmak, baska
 * projelerin kullandigi sesi degistirmek olurdu.
 *
 * @param {unknown} body `{ name, data }` — data: base64
 */
export async function uploadAmbient(body, { ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  const { name, data } = uploadName(body, AUDIO_EXTENSIONS, 'ambient');
  const buffer = decodeUpload(data, MAX_AUDIO_UPLOAD_BYTES, 'Audio');

  await mkdir(ambientDir, { recursive: true });

  const target = join(ambientDir, name);
  const exists = await stat(target).then(() => true, () => false);
  if (exists) {
    throw new ApiError(409, `Bu adda bir Ambiance zaten var: ${name}`, { name });
  }

  await writeFile(target, buffer);
  return getLibrary({ ambientDir });
}

/** Onizlemede sunulabilen ses turleri — uzanti -> MIME. */
const AMBIENT_MIMES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
};

/**
 * Bir Ambiance'in ses dosyasi — tarayicida dinlenebilsin diye.
 *
 * Secimi yapmadan once "bu ses hangisiydi" diye klasore gitmek gerekmesin.
 * Yol disariya hic cikmiyor: ad once `listAmbients` ciktisinda aranir, dosya
 * yolu oradan gelir, istekten gelen metin dosya yoluna cevrilmez.
 *
 * @param {string} name uzantisiz kisa ad ya da dosya adi
 * @returns {Promise<{ path: string, size: number, contentType: string }>}
 */
export async function getAmbientAsset(name, { ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  let available;
  try {
    available = await listAmbients(ambientDir);
  } catch (cause) {
    if (!(cause instanceof AmbientError)) throw cause;
    throw new ApiError(409, cause.message);
  }

  const found = findAmbient(available, name);
  if (found === null) throw new ApiError(404, `Ambiance bulunamadi: ${name}`);

  const contentType = AMBIENT_MIMES[extname(found.path).toLowerCase()];
  if (!contentType) throw new ApiError(400, 'Desteklenmeyen ses turu');

  const real = await realPathInside(resolve(ambientDir), found.path);
  if (!real) throw new ApiError(404, `Ambiance bulunamadi: ${name}`);

  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, `Ambiance bulunamadi: ${name}`);

  return { path: real, size: info.size, contentType };
}

/**
 * Ortak klasordeki bir Ambiance'i Geri Donusum Kutusu'na yollar.
 *
 * Kalici silme yok: ses baska projelerin project.json'unda yazili olabilir,
 * yanlislikla silinirse geri alinabilsin.
 *
 * @param {string} name uzantisiz kisa ad ya da dosya adi
 */
export async function deleteAmbient(name, { ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  let available;
  try {
    available = await listAmbients(ambientDir);
  } catch (cause) {
    if (!(cause instanceof AmbientError)) throw cause;
    throw new ApiError(409, cause.message);
  }

  const found = findAmbient(available, name);
  if (found === null) {
    throw new ApiError(404, `Ambiance bulunamadi: ${name}`, {
      available: available.map((a) => a.name),
    });
  }

  await moveFileToTrash(found.path);
  return getLibrary({ ambientDir });
}

/**
 * Ambiance secim ekraninin verisi: ortak klasordeki butun sesler, bu projede
 * secili olanlar (secim sirasiyla) ve dongu ayarlari.
 *
 * Secili olan ama artik klasorde bulunmayan ses `missing: true` ile listede
 * kalir — kullanici dosyayi tasidiysa secim sessizce silinmesin.
 *
 * @param {{ videosDir?: string, ambientDir?: string }} [options]
 */
export async function getAmbient(
  id, { videosDir = DEFAULT_VIDEOS_DIR, ambientDir = DEFAULT_AMBIENT_DIR } = {},
) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);

  let available = [];
  let error = null;
  try {
    available = await listAmbients(ambientDir);
  } catch (cause) {
    if (!(cause instanceof AmbientError)) throw cause;
    error = cause.message;
  }

  const json = await readJsonFile(status.projectPath).catch(() => null);
  const { plan, problems } = normalizeAmbientSelection(
    json !== null && typeof json === 'object' ? json.ambient : undefined,
  );

  const byName = new Map(available.map((a) => [a.name.toLowerCase(), a]));
  const selected = (plan?.tracks ?? []).map((track) => {
    const name = basename(track.path, extname(track.path));
    return {
      name,
      volumeDb: track.volumeDb,
      missing: !byName.has(name.toLowerCase()),
    };
  });

  return {
    dir: ambientDir,
    available: available.map((a) => ({ name: a.name })),
    selected,
    mode: plan?.mode ?? DEFAULT_AMBIENT_MODE,
    modes: AMBIENT_MODES,
    crossfade: plan?.crossfade ?? DEFAULT_CROSSFADE_SECONDS,
    volumeDb: plan?.volumeDb ?? null,
    defaultVolumeDb: CONFIG_DEFAULTS.audio.ambientOffsetDb,
    error,
    // project.json elle bozulmussa secim ekrani sessiz kalmasin.
    problems,
  };
}

/**
 * Ambiance secimini yazar — montaj oncesi her an degistirilebilir.
 *
 * Istemci ADLARLA konusur (kutuphanede gorundugu gibi); mutlak yola cevirmek
 * sunucunun isi, boylece istemci ortak klasorun yerini bilmek zorunda kalmaz.
 * Bos `tracks` secimi kaldirir.
 *
 * @param {unknown} body
 *   `{ tracks: (string | { name, volumeDb? })[], mode?, crossfade?, volumeDb? }`
 */
export async function updateAmbient(
  id, body, { videosDir = DEFAULT_VIDEOS_DIR, ambientDir = DEFAULT_AMBIENT_DIR } = {},
) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const input = parseBody(body, {
    tracks: 'array', mode: 'string', crossfade: 'number', volumeDb: 'number',
  }, ['tracks']);

  if (input.mode !== undefined && !AMBIENT_MODES.includes(input.mode)) {
    throw new ApiError(400, `mode must be one of: ${AMBIENT_MODES.join(', ')}`);
  }

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }

  let available;
  try {
    available = await listAmbients(ambientDir);
  } catch (cause) {
    if (!(cause instanceof AmbientError)) throw cause;
    // Secim bir dosyaya isaret ediyor; klasor okunamiyorsa yolu uyduramayiz.
    throw new ApiError(409, cause.message);
  }

  const tracks = [];
  for (const [index, item] of input.tracks.entries()) {
    const name = typeof item === 'string' ? item : item?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new ApiError(400, `tracks[${index}] must be a name or { name, volumeDb }`);
    }
    const found = findAmbient(available, name);
    if (found === null) {
      throw new ApiError(422, `Unknown ambient: ${name}`, {
        available: available.map((a) => a.name),
      });
    }
    const volumeDb = typeof item === 'string' ? null : item.volumeDb ?? null;
    if (volumeDb !== null && typeof volumeDb !== 'number') {
      throw new ApiError(400, `tracks[${index}].volumeDb must be a number`);
    }
    tracks.push({ path: found.path, volumeDb });
  }

  try {
    await setProjectAmbient(status.projectPath, tracks, {
      mode: input.mode,
      crossfade: input.crossfade,
      volumeDb: input.volumeDb,
    });
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(422, error.message);
  }

  return getAmbient(id, { videosDir, ambientDir });
}

/**
 * Etiket editorunun verisi: kayitli etiketler, onizleme kadrajinin orani, arka
 * plan olarak gosterilecek klip ve — Pomodoro aciksa — oturum zamanlari.
 *
 * Oturumlar yalnizca OKUNUR (`buildTimeline`): editor "STUDY su aralikta, BREAK bu
 * aralikta" diye gosterebilsin diye. Pomodoro ayari buradan degismez.
 */
export async function getLabels(id, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);

  const json = status.projectJson.data ?? {};
  const { labels, problems, warnings } = normalizeLabelPlan(json.labels);
  const { plan } = normalizePomodoroSelection(json.pomodoro);
  // Shorts alt projesi: dikey 9:16 çıktı, arka plan olarak ana projenin kaynak
  // videosu, Pomodoro yok. Normal proje: seçili klip ya da görsel.
  const isShorts = status.kind === 'shorts';
  let preview = null;
  if (isShorts) {
    if (status.shorts?.source?.exists) {
      preview = { url: `/api/projects/${encodeURIComponent(id)}/shorts/source`, kind: 'video' };
    }
  } else if (status.clip.exists) {
    preview = {
      url: assetUrl(id, 'video', basename(status.clip.path)),
      kind: status.videoSource === 'image' ? 'image' : 'video',
    };
  }
  const timeline = plan && !isShorts ? buildTimeline(plan) : null;

  return {
    labels,
    problems,
    warnings,
    aspect: isShorts ? '9:16' : (json.video?.aspect || CONFIG_DEFAULTS.video.aspect || '16:9'),
    preview,
    pomodoro: timeline
      ? { enabled: true, totalSeconds: timeline.totalSeconds, sessions: timeline.sessions }
      : { enabled: false, totalSeconds: 0, sessions: [] },
  };
}

/**
 * Etiketleri yazar — montaj oncesi her an degistirilebilir. Gövde `{ labels: [] }`;
 * bos dizi etiketleri kaldirir (anahtar silinir, sistem eskisi gibi calisir).
 * Gecersiz kayit 422 ve sebepleriyle reddedilir: yarim kayit yazilmaz.
 *
 * @param {unknown} body
 */
export async function updateLabels(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const input = parseBody(body, { labels: 'array' }, ['labels']);

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }

  try {
    await setProjectLabels(status.projectPath, input.labels);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(422, error.message);
  }
  return getLabels(id, { videosDir });
}

/**
 * Pomodoro ayari + MONTAJ ONCESI dogrulama.
 *
 * Ayni dogrulama build icinde de calisiyor (steps/02-audio-concat.js, parcalar
 * olculduk ten hemen sonra). Bu uc onu kullanicinin Baslat'a basmasindan ONCE
 * gosteriyor: sayilar (timeline / muzik toplami / fazla-eksik) ve kirpmanin ne
 * yapacagi montaj baslamadan ekranda.
 *
 * Kucuk bir fark var ve bilerek: burada sureler ffprobe basligindan geliyor,
 * build'de cozulen ornek sayisindan. Fark dosya basina 13-27 ms; tolerans parca
 * sayisiyla buyutuluyor ki onizleme "eksik" derken build "tam" demesin.
 */
export async function getPomodoro(id, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);

  const { plan, problems } = normalizePomodoroSelection(status.projectJson.data?.pomodoro);
  const tracks = await orderedAudioTracks(status, { probeFn });
  const validation = validatePomodoro({
    plan,
    tracks,
    tolerance: Math.max(1, tracks.length * 0.05),
  });

  return {
    enabled: validation.enabled,
    presets: POMODORO_PRESETS,
    defaults: POMODORO_DEFAULTS,
    settings: plan,
    // project.json elle bozulmussa ayar ekrani sessiz kalmasin.
    problems,
    music: {
      trackCount: tracks.length,
      totalSeconds: tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0),
      unmeasuredCount: tracks.filter((track) => track.duration === null).length,
    },
    validation: {
      ok: validation.ok,
      message: validation.message,
      problems: validation.problems,
      warnings: validation.warnings,
      needsTrimConfirmation: validation.needsTrimConfirmation,
      comparison: validation.comparison,
      trim: validation.trim,
      timeline: validation.timeline,
      cueCount: validation.cues?.events.length ?? 0,
    },
  };
}

/**
 * Pomodoro ayarini yazar — montaj oncesi her an degistirilebilir.
 *
 * Istemci sade alanlarla konusur; sekli `project.json`'a cevirmek sunucunun
 * isi (setProjectPomodoro → serializePomodoroPlan). `enabled: false` ayari
 * kaldirir ve sistem bugunku gibi calisir.
 *
 * @param {unknown} body `{ enabled, preset?, workMinutes?, breakMinutes?, rounds?,
 *   countdownSeconds?, countdownBeep?, trimExcess?, breakClip? }`
 */
export async function updatePomodoro(id, body, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const input = parseBody(body, {
    enabled: 'boolean',
    preset: 'string',
    workMinutes: 'number',
    breakMinutes: 'number',
    rounds: 'number',
    countdownSeconds: 'number',
    countdownBeep: 'boolean',
    trimExcess: 'boolean',
    // Mola görüntüsü (proje klasörüne göreli yol); '' → mola da çalışma görüntüsünü kullanır.
    breakClip: 'string',
  }, ['enabled']);
  if (input.breakClip === '') delete input.breakClip;

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }

  try {
    await setProjectPomodoro(status.projectPath, input.enabled ? input : null);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(422, error.message);
  }

  return getPomodoro(id, { videosDir, probeFn });
}

/**
 * Secim ekraninin klip listesi: selectClip'in kabul ettigi dosyalar
 * (inspectProject → videolar/*.mp4), onizleme adresi ve ffprobe olcumu.
 * Olculemeyen (bozuk/yarim) klip listede kalir, `metadata: null` doner.
 *
 * @param {{ videosDir?: string, probeFn?: typeof probe }} [options]
 */
export async function listClips(id, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  const selectedPath = status.clip.exists ? status.clip.path : null;

  const clips = [];
  for (const path of status.clips) {
    const realPath = await realPathInside(projectDir, path);
    const info = realPath && await stat(realPath).catch(() => null);
    if (!info?.isFile()) continue;

    const file = basename(path);
    let metadata = null;
    let metadataError = null;
    try {
      const probed = await probeFn(realPath);
      if (!probed.hasVideo) throw new Error('video akışı yok');
      metadata = {
        duration: probed.duration,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        videoCodec: probed.videoCodec,
        hasAudio: probed.hasAudio,
      };
    } catch (error) {
      metadataError = error.message;
    }
    clips.push({
      file,
      selected: selectedPath !== null && relative(selectedPath, path) === '',
      previewUrl: assetUrl(id, 'video', file),
      size: info.size,
      mtimeMs: info.mtimeMs,
      metadata,
      metadataError,
    });
  }

  return {
    selected: clips.find((clip) => clip.selected)?.file ?? null,
    clips,
  };
}

/**
 * Muzik asamasi — plandaki parcalar (music.tracks) ile audioDir'deki gercek
 * dosyalarin eslesmesi. Hazir olma kurali isMusicCompleted (panel ve
 * music/complete ile ayni); bu uc yalnizca okur.
 *
 * @param {{ videosDir?: string, probeFn?: typeof probe }} [options]
 */
export async function getMusic(id, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  const music = status.projectJson.data?.music;
  const plan = Array.isArray(music?.tracks) && music.tracks.length > 0 ? music.tracks : null;

  // Dosya adi eslesmesi Windows'taki gibi buyuk/kucuk harf duyarsiz.
  const audioByName = new Map();
  const audioFiles = [];
  for (const path of await audioFilesOf(status)) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const realPath = await realPathInside(projectDir, path);
    const file = basename(path);
    const audio = {
      file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      duration: realPath ? await durationOf(probeFn, realPath) : null,
      // Proje disindaki (audioDir baska yeri gosteriyorsa) dosya sunulmaz.
      previewUrl: realPath ? assetUrl(id, 'audio', file) : null,
      trackNumber: null,
    };
    audioFiles.push(audio);
    audioByName.set(file.toLowerCase(), audio);
  }

  const tracks = (plan ?? []).map((track, index) => {
    const number = Number.isInteger(track?.number) ? track.number : index + 1;
    const trackStatus = typeof track?.status === 'string' ? track.status : 'pending';
    const recorded = typeof track?.file === 'string' && track.file.trim() !== '' ? track.file : null;
    const audio = recorded && isPlainName(recorded) ? audioByName.get(recorded.toLowerCase()) : undefined;
    if (audio && audio.trackNumber === null) audio.trackNumber = number;

    let missingReason = null;
    if (!audio) {
      if (trackStatus !== 'completed') missingReason = 'not-generated';
      else missingReason = recorded ? 'file-not-found' : 'no-file-recorded';
    }
    return {
      number,
      title: typeof track?.title === 'string' ? track.title : null,
      prompt: typeof track?.prompt === 'string' ? track.prompt : null,
      status: trackStatus,
      file: recorded,
      audio: audio ? { file: audio.file, size: audio.size, duration: audio.duration, previewUrl: audio.previewUrl } : null,
      missing: !audio,
      missingReason,
    };
  });

  const completedCount = tracks.filter((track) => track.status === 'completed').length;
  const missingCount = tracks.filter((track) => track.missing).length;
  return {
    ready: isMusicCompleted(status),
    mode: plan ? 'plan' : 'files',
    status: typeof music?.status === 'string' ? music.status : null,
    completedByUser: music?.status === 'completed_by_user',
    concept: typeof music?.concept === 'string' ? music.concept : null,
    audioDir: status.audioDir,
    audioDirInsideProject: (await realPathInside(projectDir, status.audioDir)) !== null,
    summary: {
      trackCount: tracks.length,
      completedCount,
      availableCount: tracks.length - missingCount,
      missingCount,
      audioFileCount: audioFiles.length,
      unassignedFileCount: plan ? audioFiles.filter((audio) => audio.trackNumber === null).length : 0,
    },
    tracks,
    audioFiles,
    /** 8. adım "Eklediğim sıra" — dosya adları. */
    addedOrder: await audioAddedOrder(status),
  };
}

/**
 * Watermark / alttan kirpma — panelin WATERMARK CONTROL adimiyla ayni kural
 * (cropForWatermark) ve ayni alan (`video.cropBottom`, 0 = watermark yok).
 *
 * @param {unknown} body `{ watermark?: boolean, cropBottom?: number }` en az biri
 */
export async function updateCrop(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { watermark, cropBottom, cropTop, cropLeft, cropRight, aspect } = parseBody(body, {
    watermark: 'boolean',
    cropBottom: 'number',
    cropTop: 'number',
    cropLeft: 'number',
    cropRight: 'number',
    aspect: 'string',
  });
  if (watermark === undefined && cropBottom === undefined && cropTop === undefined && cropLeft === undefined && cropRight === undefined && aspect === undefined) {
    throw new ApiError(400, 'Missing field: watermark, crop, or aspect');
  }
  if (aspect !== undefined && !['16:9', '9:16'].includes(aspect)) {
    throw new ApiError(400, `Geçersiz aspect: "${aspect}" (desteklenen: 16:9, 9:16)`);
  }
  if (cropBottom !== undefined && !isCropBottom(cropBottom)) {
    throw new ApiError(400, 'cropBottom must be a non-negative integer');
  }
  if (cropTop !== undefined && !isCropBottom(cropTop)) {
    throw new ApiError(400, 'cropTop must be a non-negative integer');
  }
  if (cropLeft !== undefined && !isCropBottom(cropLeft)) {
    throw new ApiError(400, 'cropLeft must be a non-negative integer');
  }
  if (cropRight !== undefined && !isCropBottom(cropRight)) {
    throw new ApiError(400, 'cropRight must be a non-negative integer');
  }
  if (watermark !== undefined && cropBottom !== undefined && cropTop === undefined && cropLeft === undefined && cropRight === undefined && watermark !== (cropBottom > 0)) {
    throw new ApiError(400, 'watermark must be true exactly when cropBottom > 0');
  }

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }

  const currentVideo = status.projectJson.data?.video ?? {};
  const currentBottom = isCropBottom(currentVideo.cropBottom) ? currentVideo.cropBottom : 0;
  const currentTop = isCropBottom(currentVideo.cropTop) ? currentVideo.cropTop : 0;
  const currentLeft = isCropBottom(currentVideo.cropLeft) ? currentVideo.cropLeft : 0;
  const currentRight = isCropBottom(currentVideo.cropRight) ? currentVideo.cropRight : 0;

  let effectiveBottom = cropBottom !== undefined ? cropBottom : (watermark !== undefined ? cropForWatermark(watermark, currentBottom) : currentBottom);
  let effectiveTop = cropTop !== undefined ? cropTop : (watermark === false && cropBottom === undefined ? 0 : currentTop);
  let effectiveLeft = cropLeft !== undefined ? cropLeft : (watermark === false && cropBottom === undefined ? 0 : currentLeft);
  let effectiveRight = cropRight !== undefined ? cropRight : (watermark === false && cropBottom === undefined ? 0 : currentRight);

  if (watermark === false && cropBottom === undefined && cropTop === undefined && cropLeft === undefined && cropRight === undefined) {
    effectiveBottom = 0;
    effectiveTop = 0;
    effectiveLeft = 0;
    effectiveRight = 0;
  }

  try {
    await setProjectCrop(status.projectPath, {
      cropBottom: effectiveBottom,
      cropTop: effectiveTop > 0 ? effectiveTop : (cropTop !== undefined || (watermark === false && currentTop > 0) ? 0 : undefined),
      cropLeft: effectiveLeft > 0 ? effectiveLeft : (cropLeft !== undefined || (watermark === false && currentLeft > 0) ? 0 : undefined),
      cropRight: effectiveRight > 0 ? effectiveRight : (cropRight !== undefined || (watermark === false && currentRight > 0) ? 0 : undefined),
      aspect,
    });
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(409, 'project.json is invalid', { problem: error.message });
  }
  return getProject(id, { videosDir });
}

/**
 * "Muzigi bitir ve devam et" — panelle ayni completeMusicByUser. Panel bu
 * secenegi elde en az bir sarki varken sunar; web parcalari tek tek
 * isaretlemedigi icin kanit audio klasorundeki dosyalardir.
 * Muzik zaten bittiyse dosyaya dokunmadan guncel projeyi dondurur.
 *
 * @param {unknown} body bos ya da `{}`
 */
export async function completeMusic(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  parseBody(body ?? {}, {});

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }
  if (isMusicCompleted(status)) return getProject(id, { videosDir });

  const music = status.projectJson.data.music;
  if (!Array.isArray(music?.tracks) || music.tracks.length === 0) {
    throw new ApiError(409, 'Project has no music plan', { audioCount: status.audioCount });
  }
  if (status.audioCount === 0) {
    throw new ApiError(409, 'No audio files in the project audio folder', { audioDir: status.audioDir });
  }

  try {
    await completeMusicByUser(status.projectPath, music);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(409, 'project.json is invalid', { problem: error.message });
  }
  return getProject(id, { videosDir });
}

/**
 * Projeyi siler: klasörün tamami (resimler, müzik, cikti) Geri Dönüşüm
 * Kutusu'na tasinir, kalici silinmez. Montaji süren proje silinmez.
 *
 * @param {{ videosDir?: string, buildJobs?: { get: (id: string) => object|null }, trashFn?: typeof moveDirToTrash }} [options]
 * @returns {Promise<{ deleted: string }>}
 */
export async function deleteProject(id, { videosDir = DEFAULT_VIDEOS_DIR, buildJobs, trashFn = moveDirToTrash } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  if (buildJobs?.get(id)?.state === 'running') {
    throw new ApiError(409, 'Build is running for this project');
  }
  // Junction/symlink ile videolar\ disini gösteren klasör silinmez.
  const realRoot = await realpath(videosDir).catch(() => null);
  const realDir = await realpath(projectDir).catch(() => null);
  if (!realRoot || !realDir || !isInside(realRoot, realDir)) {
    throw new InvalidProjectIdError();
  }
  await trashFn(realDir);
  return { deleted: id };
}

/**
 * Montaji arka planda baslatir. Panel gibi build.js'i ayri surecte calistirir;
 * hazir olmayan projeyi (nextStep build/done degil) baslatmaz.
 *
 * @param {unknown} body `{ overwrite? }`
 * @param {{ videosDir?: string, buildJobs: ReturnType<typeof import('./build-jobs.js').createBuildJobs> }} options
 */
export async function startBuild(id, body, { videosDir = DEFAULT_VIDEOS_DIR, buildJobs, probeFn = probe }) {
  const projectDir = await resolveProjectDir(id, videosDir);
  // `render`: uzun videoyu da üret. Varsayılan TRUE — bu uç arayüzün "Montaj"
  // adımı için var ve o adım `out/<çıktı>.mp4` görünce tamamlanıyor. build.js'in
  // CLI varsayılanı (yalnızca yayın paketi) burada geçerli değil; isteyen
  // `render: false` ile sadece paket üretebilir.
  const { overwrite = false, render = true } = parseBody(body ?? {}, {
    overwrite: 'boolean',
    render: 'boolean',
  });

  const status = await inspectProject(projectDir);
  const step = nextStep(status);
  // Kirpma degeri yoksa build.js konfig hatasiyla durur; hic baslatma.
  if ((step.id !== 'build' && step.id !== 'done') || !isCropBottom(status.projectJson.data?.video?.cropBottom)) {
    throw new ApiError(409, 'Project is not ready to build', {
      step,
      missing: describeReadiness(status).build.missing,
    });
  }
  // build.js video ya da tracklist varken --overwrite ister (runBuild adım 0).
  const existing = [
    ...(status.output.exists ? [status.output.path] : []),
    ...(status.output.tracklistExists ? [status.output.tracklistPath] : []),
  ];
  if (existing.length > 0 && !overwrite) {
    throw new ApiError(409, 'Output already exists', { output: status.output.path, existing });
  }

  // Pomodoro dogrulamasi gecmeden montaj baslatilmaz (spec bolum 8). build.js
  // ayni denetimi kendi icinde de yapiyor; buradaki amac kullaniciyi bos yere
  // calisan bir montajla bekletmemek ve hatayi hemen gostermek.
  const pomodoro = await getPomodoro(id, { videosDir, probeFn });
  if (!pomodoro.validation.ok) {
    throw new ApiError(409, 'Pomodoro validation failed', {
      pomodoro: pomodoro.validation,
      message: pomodoro.validation.message,
    });
  }

  return buildJobs.start(id, { projectPath: status.projectPath, overwrite, render });
}

/**
 * Projenin son montaj isi (bu sunucu oturumunda; yoksa `state: 'idle'`) ve
 * diskteki guncel cikti. Is kaydi sunucu yeniden baslayinca kaybolur, cikti
 * durumu her zaman diskten okunur.
 */
export async function getBuild(id, { videosDir = DEFAULT_VIDEOS_DIR, buildJobs }) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const job = buildJobs.get(id);
  const output = await describeOutput(id, projectDir, await inspectProject(projectDir));
  return { ...job, output };
}

/**
 * Salt okunur asset onizlemesi. Yalnizca inspectProject'in bu tur icin
 * gosterdigi dosyalar sunulur; klip/cikti yolu project.json'dan geldigi icin
 * gercek yol (symlink/junction cozulmus) proje klasorunun icinde olmali.
 *
 * @returns {Promise<{ path: string, size: number, contentType: string }>}
 */
export async function getAsset(id, assetType, filename, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  if (!Object.hasOwn(ASSET_TYPES, assetType)) throw new ApiError(400, 'Invalid asset type');
  if (!isPlainName(filename)) throw new ApiError(400, 'Invalid filename');

  const notFound = new ApiError(404, 'Asset not found');
  const contentType = assetContentType(assetType, filename);
  if (!contentType) throw notFound;

  const status = await inspectProject(projectDir);
  const path = (await ASSET_TYPES[assetType].files(status)).find((candidate) => basename(candidate) === filename);
  if (!path) throw notFound;

  const realPath = await realPathInside(projectDir, path);
  if (!realPath) throw notFound;
  const info = await stat(realPath).catch(() => null);
  if (!info?.isFile()) throw notFound;
  return { path: realPath, size: info.size, contentType };
}

/**
 * Asama asama kanit — workflow sirasindan bagimsiz. nextStep "sirada ne var"
 * der; bu ise her on kosulun gercekten saglanip saglanmadigini soyler
 * (orn. muzik adimindaki projede klip henuz yok).
 */
export function describeReadiness(status) {
  const music = status.projectJson.data?.music;
  const tracks = Array.isArray(music?.tracks) ? music.tracks : [];
  const musicReady = isMusicCompleted(status);
  const clipReady = status.clip.exists;
  const videoData = status.projectJson.data?.video ?? {};
  const cropBottom = videoData.cropBottom;
  const cropTop = videoData.cropTop ?? 0;
  const cropLeft = videoData.cropLeft ?? 0;
  const cropRight = videoData.cropRight ?? 0;
  // Tek resim modunda watermark kararı yok (görselde watermark olmaz), o yüzden
  // cropBottom yazılmamış olması montajı engellemez — 0 sayılır.
  const cropReady = isCropBottom(cropBottom) || status.videoSource === 'image';
  const { plan: pomodoroPlan } = normalizePomodoroSelection(status.projectJson.data?.pomodoro);

  const missing = [];
  if (!status.projectJson.ok) missing.push('projectJson');
  if (!clipReady) missing.push('clip');
  if (!musicReady) missing.push('music');
  if (status.projectJson.ok && !cropReady) missing.push('cropBottom');

  return {
    clip: {
      ready: clipReady,
      selected: status.clip.value || null,
      availableCount: status.clips.length,
    },
    music: {
      ready: musicReady,
      audioCount: status.audioCount,
      trackCount: tracks.length,
      completedTrackCount: tracks.filter((track) => track.status === 'completed').length,
      status: typeof music?.status === 'string' ? music.status : null,
    },
    video: {
      ready: cropReady,
      cropBottom: isCropBottom(cropBottom) ? cropBottom : null,
      watermark: isCropBottom(cropBottom) ? cropBottom > 0 : null,
      defaultCropBottom: DEFAULT_CROP_BOTTOM,
    },
    // Pomodoro burada yalnizca "acik mi, hangi duzen" diyor. Muzigin timeline'i
    // doldurup doldurmadigi parcalarin olculmesini gerektiriyor (async), o yuzden
    // `missing` listesine girmez — onu GET /api/projects/:id/pomodoro soyler.
    pomodoro: pomodoroPlan === null
      ? { enabled: false }
      : {
        enabled: true,
        preset: pomodoroPlan.preset,
        workMinutes: pomodoroPlan.workMinutes,
        breakMinutes: pomodoroPlan.breakMinutes,
        rounds: pomodoroPlan.rounds,
        totalMinutes: buildTimeline(pomodoroPlan).totalMinutes,
        breakClip: pomodoroPlan.breakClip,
      },
    build: { ready: missing.length === 0, missing },
    output: { exists: status.output.exists },
  };
}

// ---------------------------------------------------------------- yardimcilar

/** Kimligi dogrular; videolar kokunun dogrudan alti ve project.json'lu olmali. */
/**
 * Proje klasorunun guvenli cozumu: ad duz olmali, kok klasorun icinde
 * kalmali, icinde project.json bulunmali. `server/shorts-api.js` de bunu
 * kullaniyor — ayni dogrulama iki yerde ayri yazilmasin.
 */
export async function resolveProjectDir(id, videosDir) {
  if (!isPlainName(id)) throw new InvalidProjectIdError();

  const root = resolve(videosDir);
  const projectDir = resolve(root, id);
  if (!isInside(root, projectDir)) throw new InvalidProjectIdError();

  const info = await stat(join(projectDir, 'project.json')).catch(() => null);
  if (!info?.isFile()) throw new ProjectNotFoundError();
  return projectDir;
}

/** build.js'in kabul ettigi `video.cropBottom` (core/config.js nonNegativeInt). */
function isCropBottom(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Uzantidan MIME; tur o aileyi sunmuyorsa null. */
function assetContentType(assetType, filename) {
  const contentType = ASSET_MIME_TYPES[extname(filename).toLowerCase()];
  const kinds = [].concat(ASSET_TYPES[assetType].kind);
  return contentType && kinds.some((kind) => contentType.startsWith(kind)) ? contentType : null;
}

/**
 * Montaj ciktisi (video + tracklist) — dosya bilgisi ve onizleme adresi.
 * Cikti klasoru project.json'da proje disini gosterebilir: o zaman sunulmaz.
 */
async function describeOutput(id, projectDir, status) {
  const describe = async (assetType, path, exists) => {
    const file = basename(path);
    const info = exists ? await stat(path).catch(() => null) : null;
    if (!info?.isFile()) return { exists: false, file, size: null, mtimeMs: null, previewUrl: null };
    const servable = assetContentType(assetType, file) !== null && await realPathInside(projectDir, path);
    return {
      exists: true,
      file,
      size: info.size,
      mtimeMs: info.mtimeMs,
      previewUrl: servable ? assetUrl(id, assetType, file) : null,
    };
  };
  const tracklist = await describe('tracklist', status.output.tracklistPath, status.output.tracklistExists);
  const tracklistText = tracklist.exists && await realPathInside(projectDir, status.output.tracklistPath)
    ? await readFile(status.output.tracklistPath, 'utf8').catch(() => null)
    : null;
  return {
    ...await describe('output', status.output.path, status.output.exists),
    tracklist: { ...tracklist, text: tracklistText },
  };
}

/** audioDir'deki ses dosyalari; klasor yoksa bos (inspectProject gibi). */
async function audioFilesOf(status) {
  return listFiles(status.audioDir, AUDIO_EXTENSIONS).catch(() => []);
}

/** ffprobe suresi; olculemeyen dosyada null. */
async function durationOf(probeFn, path) {
  try {
    return (await probeFn(path)).duration ?? null;
  } catch {
    return null;
  }
}

async function ambientsOrEmpty(ambientDir) {
  try {
    return await listAmbients(ambientDir);
  } catch (error) {
    if (error instanceof AmbientError) return [];
    throw error;
  }
}

/**
 * Symlink/junction cozulmus gercek yol proje klasorunun icindeyse onu, degilse
 * (ya da dosya yoksa) null dondurur.
 */
async function realPathInside(projectDir, path) {
  const [realRoot, realPath] = await Promise.all([
    realpath(projectDir).catch(() => null),
    realpath(path).catch(() => null),
  ]);
  return realRoot && realPath && isInside(realRoot, realPath) ? realPath : null;
}

/** getAsset rotasinin adresi (web-server.js). */
function assetUrl(id, assetType, filename) {
  return `/api/projects/${encodeURIComponent(id)}/assets/${assetType}/${encodeURIComponent(filename)}`;
}

async function exists(path) {
  return (await stat(path).catch(() => null)) !== null;
}

function parseCreateBody(body) {
  const input = parseBody(
    body,
    { name: 'string', ambient: 'array', videoSource: 'string', concept: 'string', totalTracks: 'number', parentId: 'string', selectedTracks: 'array', aspect: 'string', pomodoro: 'object' },
    ['name'],
  );
  if (input.pomodoro !== undefined && (input.pomodoro === null || Array.isArray(input.pomodoro))) {
    throw new ApiError(400, 'pomodoro must be an object');
  }
  // Mola görüntüsü dosyası proje kurulunca yüklenir; kurulum sırasında seçilemez.
  if (input.pomodoro?.breakClip !== undefined) {
    throw new ApiError(400, 'pomodoro.breakClip cannot be set while creating a project');
  }

  const ambient = input.ambient ?? [];
  if (!ambient.every((name) => typeof name === 'string' && name.trim() !== '')) {
    throw new ApiError(400, 'ambient must be an array of names');
  }
  if (input.videoSource !== undefined && !VIDEO_SOURCES.includes(input.videoSource)) {
    throw new ApiError(400, `videoSource must be one of: ${VIDEO_SOURCES.join(', ')}`);
  }
  if (input.aspect !== undefined && input.aspect !== '16:9' && input.aspect !== '9:16') {
    throw new ApiError(400, 'aspect must be one of: 16:9, 9:16');
  }
  if (input.concept !== undefined && input.concept.length > MAX_CONCEPT_LENGTH) {
    throw new ApiError(400, `concept must be at most ${MAX_CONCEPT_LENGTH} characters`);
  }
  if (input.totalTracks !== undefined
    && (!Number.isInteger(input.totalTracks) || input.totalTracks < 1 || input.totalTracks > MAX_TRACKS)) {
    throw new ApiError(400, `totalTracks must be an integer between 1 and ${MAX_TRACKS}`);
  }

  const selectedTracks = Array.isArray(input.selectedTracks)
    ? input.selectedTracks.filter((t) => typeof t === 'string' && t.trim() !== '')
    : undefined;
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() !== ''
    ? input.parentId.trim()
    : undefined;

  const concept = input.concept?.trim();
  return {
    name: input.name,
    ambient,
    videoSource: input.videoSource,
    concept: concept || undefined,
    totalTracks: input.totalTracks,
    parentId,
    selectedTracks,
    aspect: input.aspect,
    // Yalnızca Pomodoro seçildiyse; alan alan doğrulama setProjectPomodoro'da.
    pomodoro: input.pomodoro === undefined ? undefined : { ...input.pomodoro, enabled: true },
  };
}

/**
 * Duz JSON nesnesi; bilinmeyen anahtar ve yanlis tip 400.
 *
 * @param {unknown} body
 * @param {Record<string, 'string'|'number'|'boolean'|'array'>} schema
 * @param {string[]} [required]
 */
export function parseBody(body, schema, required = []) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Request body must be a JSON object');
  }
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(schema, key)) throw new ApiError(400, `Unknown field: ${key}`);
  }
  for (const key of required) {
    if (body[key] === undefined) throw new ApiError(400, `Missing field: ${key}`);
  }
  for (const [key, type] of Object.entries(schema)) {
    const value = body[key];
    if (value === undefined) continue;
    const ok = type === 'array' ? Array.isArray(value) : typeof value === type;
    if (!ok) throw new ApiError(400, `Field ${key} must be ${type === 'array' ? 'an array' : `a ${type}`}`);
  }
  return body;
}

/** Tek bir yol parcasi: ayirici, `.`/`..` ve NUL icermez. */
function isPlainName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    basename(name) === name;
}

/** `path`, `root`un altinda (kendisi degil). */
function isInside(root, path) {
  const pathRelativeToRoot = relative(root, path);
  return pathRelativeToRoot !== '' &&
    pathRelativeToRoot.split(sep)[0] !== '..' &&
    !isAbsolute(pathRelativeToRoot);
}

export function openFolderOnOs(targetPath) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('explorer.exe', [targetPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [targetPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } else {
      const child = spawn('xdg-open', [targetPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
  } catch {
    return false;
  }
}

export async function openProjectFolder(id, body = {}, {
  videosDir = DEFAULT_VIDEOS_DIR,
  openFn = openFolderOnOs,
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { folder } = parseBody(body ?? {}, { folder: 'string' });
  const targetDir = folder ? join(projectDir, folder) : projectDir;

  const realProject = await realpath(projectDir).catch(() => resolve(projectDir));
  const realTarget = await realpath(targetDir).catch(() => resolve(targetDir));
  const rel = relative(realProject, realTarget);
  if (rel.startsWith('..') && !isAbsolute(rel) && rel !== '') {
    throw new ApiError(400, 'Invalid folder path');
  }

  const ok = openFn(realTarget);
  return { ok, path: realTarget };
}

/** Tarayıcıdan gelen base64 (data: URL olabilir) dosya içeriği; boş ya da sınır üstü reddedilir. */
function decodeUpload(data, maxBytes, label) {
  const base64Clean = data.includes(',') ? data.split(',')[1] : data;
  const buffer = Buffer.from(base64Clean, 'base64');
  if (buffer.length === 0) throw new ApiError(400, `${label} data is empty`);
  if (buffer.length > maxBytes) {
    throw new ApiError(422, `${label} exceeds ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  return buffer;
}

/** Yüklenen dosyanın `{ name, data }` alanları; ad düz, uzantı izinli listede olmalı. */
function uploadName(body, extensions, label, extraFields = {}) {
  const { name, data } = parseBody(body ?? {}, { name: 'string', data: 'string', ...extraFields }, ['name', 'data']);
  if (!isPlainName(name)) throw new ApiError(400, `Invalid ${label} file name`);
  const ext = extname(name).toLowerCase();
  if (!extensions.includes(ext)) {
    throw new ApiError(400, `Unsupported ${label} format (${ext}). Supported: ${extensions.join(', ')}`);
  }
  return { name, data, ext };
}

/** project.json `workflow` nesnesi (yoksa boş). */
function workflowOf(status) {
  const value = status.projectJson.data?.workflow;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const MAX_CLIP_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Görsel yüklemesi → resimler/. Dosya kullanıcının verdiği adla yazılır; ad
 * zaten varsa benzersizleştirilir (yüklenen görsel sessizce ezilmesin).
 *
 * Yuva (master/açı) kavramı yok: `inspectProject` resimler\ altındaki BÜTÜN
 * görselleri aday sayıyor, hangisinin kullanılacağına Video adımında seçimle
 * karar veriliyor.
 *
 * @param {unknown} body `{ name, data }`
 */
export async function uploadProjectImage(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { name, data } = uploadName(body, IMAGE_EXTENSIONS, 'image');
  const buffer = decodeUpload(data, MAX_IMAGE_SIZE_BYTES, 'Image');

  const imagesDir = join(projectDir, 'resimler');
  await mkdir(imagesDir, { recursive: true });
  await writeFile(join(imagesDir, await uniqueFileName(imagesDir, name)), buffer);
  return getProject(id, { videosDir });
}

/**
 * Adım 6 klip yüklemesi → videolar/<ad>.mp4. Seçim (ve kırpma) Video
 * adımında selectClip/updateCrop ile kaydedilir.
 *
 * @param {unknown} body `{ name, data }`
 */
export async function uploadProjectClip(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { name, data } = uploadName(body, ['.mp4'], 'video');
  const buffer = decodeUpload(data, MAX_CLIP_UPLOAD_BYTES, 'Video');
  const clipsDir = join(projectDir, 'videolar');
  await mkdir(clipsDir, { recursive: true });
  await writeFile(join(clipsDir, name), buffer);
  return getProject(id, { videosDir });
}

/**
 * Adım 7 müzik yüklemesi → projenin audioDir'i. audioDir proje dışını
 * gösteriyorsa yazılmaz.
 *
 * @param {unknown} body `{ name, data }`
 */
export async function uploadProjectAudio(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { name, data } = uploadName(body, AUDIO_EXTENSIONS, 'audio');
  const buffer = decodeUpload(data, MAX_AUDIO_UPLOAD_BYTES, 'Audio');
  const status = await inspectProject(projectDir);
  const outside = new ApiError(409, 'audioDir is outside the project folder', { audioDir: status.audioDir });
  if (!isInside(resolve(projectDir), resolve(status.audioDir))) throw outside;
  await mkdir(status.audioDir, { recursive: true });
  if (!(await realPathInside(projectDir, status.audioDir))) throw outside;
  await writeFile(join(status.audioDir, name), buffer);
  await recordAudioAdded(status.projectPath, [name]);
  return getProject(id, { videosDir });
}

/**
 * Adım 8 → project.json `order` (build.js'in okuduğu alan) ve
 * `workflow.order` (seçilen yöntem). Alfabetik: audioDir'in doğal sırası
 * (build'in sırasız düşüşüyle aynı listFiles sırası). Eklediğim sıra:
 * audioAddedOrder (kayıtlı eklenme sırası, yoksa oluşturulma zamanı).
 *
 * @param {unknown} body `{ mode: 'alphabetical'|'added'|'manual', order?: string[] }`
 */
export async function updateTrackOrder(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { mode, order } = parseBody(body ?? {}, { mode: 'string', order: 'object' }, ['mode']);
  if (!TRACK_ORDER_MODES.includes(mode)) {
    throw new ApiError(400, `mode must be one of: ${TRACK_ORDER_MODES.join(', ')}`);
  }

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }
  const files = (await audioFilesOf(status)).map((path) => basename(path));
  if (files.length === 0) {
    throw new ApiError(409, 'No audio files in the project audio folder', { audioDir: status.audioDir });
  }

  let names = files;
  if (mode === 'added') {
    names = await audioAddedOrder(status);
  } else if (mode === 'manual') {
    const valid = Array.isArray(order)
      && order.length === files.length
      && new Set(order).size === order.length
      && order.every((name) => files.includes(name));
    if (!valid) {
      throw new ApiError(422, 'order must list every audio file exactly once', { available: files });
    }
    names = order;
  }

  try {
    await setProjectField(status.projectPath, 'order', names);
    await setProjectField(status.projectPath, 'workflow', { ...workflowOf(status), order: mode });
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    throw new ApiError(409, 'project.json is invalid', { problem: error.message });
  }
  return getProject(id, { videosDir });
}

