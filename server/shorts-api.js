/**
 * Shorts alt projesi API'si — 9:16 dikey kesitler.
 *
 * Tek sorumluluk: HTTP katmanının ihtiyacı olan okuma/yazma işlemlerini
 * birleştirmek. Kurallar `core/shorts-plan.js`'te, project.json yazımı
 * `prep/shorts-file.js`'te, render `steps/08-shorts-export.js`'te.
 *
 * Temel karar: KAYNAK VİDEO KOPYALANMAZ. Alt proje ana projedeki dosyaya
 * (çıktı videosu ya da seçili klip) bir yol tutar; kesitler o dosyanın zaman
 * aralıklarıdır. Yalnızca "Render" dendiğinde o aralık ayrı bir dosya olur.
 * Böylece mevcut montaj zinciri (01–07) ve ana projenin dosyaları hiç
 * etkilenmez.
 */

import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

import { probe } from '../core/probe.js';
import {
  computeShortsCrop,
  formatTimecode,
  MAX_SHORTS_SECONDS,
  MAX_ZOOM,
  MIN_CLIP_SECONDS,
  MIN_ZOOM,
  SHORTS_TARGET,
} from '../core/shorts-plan.js';
import { moveFileToTrash } from '../core/trash.js';
import { writeTextFile } from '../core/workspace.js';
import { inspectProject, nextStep, projectWorkflow } from '../prep/project-status.js';
import { DEFAULT_VIDEOS_DIR, validateVideoName } from '../prep/scaffold.js';
import {
  addShortsClip,
  markShortsClipRendered,
  removeShortsClip,
  updateShortsClip,
} from '../prep/shorts-file.js';
import { exportShortsClip } from '../steps/08-shorts-export.js';
import { ApiError, parseBody, resolveProjectDir } from './project-api.js';

/** Kaynak olarak kabul edilen video uzantıları (ana projedeki dosyalar). */
const SOURCE_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'];

const SOURCE_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
};

/**
 * Render işleri — bellekte. `server/build-jobs.js` ile aynı gerekçe: asıl
 * sonuç diskteki dosya, bu kayıt yalnızca "şu an çalışıyor mu" sorusu için.
 * Aynı anda tek render: ffmpeg makineyi zaten doyuruyor.
 * @type {Map<string, object>}
 */
const renderJobs = new Map();
let runningRender = null;

const jobKey = (projectId, clipId) => `${projectId}::${clipId}`;

/** 409 — ffmpeg makineyi doyurduğu için aynı anda tek render. */
class ShortsRenderRunningError extends ApiError {
  constructor(key) {
    super(409, 'Zaten bir Shorts render çalışıyor.', { running: key });
    this.name = 'ShortsRenderRunningError';
  }
}

/** Shorts projesi mi? Değilse 400 — yanlış ekrana yanlış istek gitmesin. */
function assertShorts(status, id) {
  if (status.kind !== 'shorts') {
    throw new ApiError(400, `"${id}" bir Shorts alt projesi değil.`);
  }
}

/**
 * Ana projenin Shorts kaynağı olabilecek videoları: montaj çıktısı ve
 * seçili/aday klipler. Kopyalama yok — yalnızca yollar.
 *
 * @param {Awaited<ReturnType<typeof inspectProject>>} parent
 * @returns {{ path: string, label: string, role: 'output'|'clip' }[]}
 */
function parentSourceCandidates(parent) {
  const candidates = [];
  if (parent.output.exists) {
    candidates.push({ path: parent.output.path, label: basename(parent.output.path), role: 'output' });
  }
  if (parent.clip.exists && SOURCE_EXTENSIONS.includes(extname(parent.clip.path).toLowerCase())) {
    candidates.push({ path: parent.clip.path, label: basename(parent.clip.path), role: 'clip' });
  }
  for (const clip of parent.clips) {
    if (!SOURCE_EXTENSIONS.includes(extname(clip).toLowerCase())) continue;
    if (candidates.some((candidate) => candidate.path === clip)) continue;
    candidates.push({ path: clip, label: basename(clip), role: 'clip' });
  }
  return candidates;
}

/**
 * Ana projeden Shorts alt projesi açar.
 *
 * Klasör `mkdir` ile özyinelemesiz açılır (varsa EEXIST → 409): "var mı"
 * sorusu ile oluşturma arasında yarış olmaz — `prep/scaffold.js` ile aynı
 * kural. project.json elle yazılıyor çünkü `planProject` 17 parçalık müzik
 * planı üretiyor; Shorts projesinde müzik/montaj yok.
 *
 * @param {string} parentId
 * @param {unknown} body `{ name?, source? }` — source: ana projedeki dosya adı
 */
export async function createShortsSubproject(parentId, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const input = parseBody(body ?? {}, { name: 'string', source: 'string' });
  const parentDir = await resolveProjectDir(parentId, videosDir);
  const parent = await inspectProject(parentDir);
  if (parent.kind === 'shorts') {
    throw new ApiError(400, 'Shorts alt projesine yeniden Shorts alt projesi açılamaz.');
  }

  const candidates = parentSourceCandidates(parent);
  if (candidates.length === 0) {
    throw new ApiError(422, 'Ana projede kaynak video yok: önce klip yükle ya da montajı tamamla.', {
      missing: ['source'],
    });
  }

  const chosen = input.source
    ? candidates.find((candidate) => basename(candidate.path) === input.source)
    : candidates[0];
  if (!chosen) {
    throw new ApiError(404, `Kaynak video bulunamadı: ${input.source}`, {
      available: candidates.map((candidate) => candidate.label),
    });
  }

  const name = (input.name ?? '').trim() || await nextShortsName(parentId, videosDir);
  const problems = validateVideoName(name);
  if (problems.length > 0) throw new ApiError(400, problems.join('; '), { problems });

  const dir = resolve(videosDir, name);
  const project = {
    kind: 'shorts',
    parentId,
    // Yol GÖRECELİ: videolar kökü taşınsa da kaynak bulunur (inspectProject
    // göreceli yolu proje klasörüne göre çözüyor).
    shorts: { source: relative(dir, chosen.path), clips: [] },
    video: { aspect: SHORTS_TARGET.aspect },
    output: { dir: './out' },
  };

  try {
    await mkdir(dir);
  } catch (cause) {
    if (cause.code === 'EEXIST') throw new ApiError(409, `Klasör zaten var: ${dir}`);
    throw new ApiError(500, `Alt proje klasörü açılamadı: ${cause.code ?? cause.message}`);
  }
  try {
    await writeTextFile(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  } catch (cause) {
    await rm(dir, { recursive: true, force: true }).catch(() => null);
    throw new ApiError(500, `project.json yazılamadı: ${cause.message}`);
  }

  return { ...(await getShorts(name, { videosDir })), created: true };
}

/** `<ana proje> Shorts 01` — kullanılmayan ilk ad. */
async function nextShortsName(parentId, videosDir) {
  for (let counter = 1; counter < 100; counter++) {
    const name = `${parentId} Shorts ${String(counter).padStart(2, '0')}`;
    const info = await stat(resolve(videosDir, name)).catch(() => null);
    if (info === null) return name;
  }
  throw new ApiError(409, 'Boş Shorts alt proje adı bulunamadı (100 sınırı).');
}

/**
 * Shorts alt projesinin tam durumu: kaynak videonun ölçümü, kesitler
 * (hesaplanmış kadraj + render durumu) ve açık render işleri.
 *
 * @param {string} id
 */
export async function getShorts(id, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const shorts = status.shorts;
  const measured = shorts.source.exists ? await probeFn(shorts.source.path).catch(() => null) : null;
  const source = {
    value: shorts.source.value,
    path: shorts.source.path,
    exists: shorts.source.exists,
    name: shorts.source.path ? basename(shorts.source.path) : null,
    duration: measured?.duration ?? null,
    width: measured?.width ?? null,
    height: measured?.height ?? null,
    fps: measured?.fps ?? null,
    hasAudio: measured?.hasAudio ?? null,
    /** <video> doğrudan buradan oynatır (Range destekli). */
    url: shorts.source.exists ? `/api/projects/${encodeURIComponent(id)}/shorts/source` : null,
  };

  const clips = shorts.clips.map((clip) => describeClip(id, clip, source));

  return {
    id,
    name: status.name,
    parentId: status.parentId,
    kind: status.kind,
    dir: projectDir,
    outputDir: shorts.dir,
    target: SHORTS_TARGET,
    limits: {
      minSeconds: MIN_CLIP_SECONDS,
      maxSeconds: MAX_SHORTS_SECONDS,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
    },
    source,
    clips,
    problems: shorts.problems,
    warnings: shorts.warnings,
    renders: listRenders(id),
    step: nextStep(status),
    workflow: projectWorkflow(status),
  };
}

/** Bir kesidin UI'ya giden hali: zaman damgaları, kadraj pikselleri, çıktı. */
function describeClip(id, clip, source) {
  const crop = source.width && source.height
    ? computeShortsCrop({
      sourceWidth: source.width,
      sourceHeight: source.height,
      zoom: clip.frame.zoom,
      x: clip.frame.x,
      y: clip.frame.y,
    })
    : null;

  return {
    id: clip.id,
    title: clip.title,
    start: clip.start,
    end: clip.end,
    duration: clip.duration,
    startLabel: formatTimecode(clip.start),
    endLabel: formatTimecode(clip.end),
    durationLabel: formatTimecode(clip.duration),
    frame: clip.frame,
    crop,
    output: clip.output,
    outputPath: clip.outputPath,
    rendered: clip.outputExists,
    outputSize: clip.outputSize,
    renderedAt: clip.renderedAt,
    videoUrl: clip.outputExists
      ? `/api/projects/${encodeURIComponent(id)}/shorts/clips/${encodeURIComponent(clip.id)}/video`
      : null,
    overLimit: clip.duration > MAX_SHORTS_SECONDS,
  };
}

/** Kesit gövdesi: `start`, `end`, `title`, `frame`. */
function parseClipBody(body, { requireRange }) {
  const input = parseBody(
    body ?? {},
    { start: 'number', end: 'number', title: 'string', frame: 'object' },
    requireRange ? ['start', 'end'] : [],
  );
  const frame = input.frame === undefined ? undefined : parseBody(
    input.frame,
    { zoom: 'number', x: 'number', y: 'number' },
  );
  return { ...input, ...(frame ? { frame } : {}) };
}

/** "Bu Aralığı Al" — yeni kesit. */
export async function createShortsClip(id, body, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const input = parseClipBody(body, { requireRange: true });
  const sourceDuration = await sourceDurationOf(status, probeFn);

  try {
    await addShortsClip(status.projectPath, input, { sourceDuration });
  } catch (cause) {
    throw new ApiError(422, cause.message);
  }
  return getShorts(id, { videosDir, probeFn });
}

/** Aralığı/kadrajı/başlığı güncelle. */
export async function patchShortsClip(id, clipId, body, { videosDir = DEFAULT_VIDEOS_DIR, probeFn = probe } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const input = parseClipBody(body, { requireRange: false });
  const sourceDuration = await sourceDurationOf(status, probeFn);

  try {
    await updateShortsClip(status.projectPath, clipId, input, { sourceDuration });
  } catch (cause) {
    throw new ApiError(cause.message.includes('bulunamadı') ? 404 : 422, cause.message);
  }
  return getShorts(id, { videosDir, probeFn });
}

/**
 * Kesidi siler. Render edilmiş dosya varsa Geri Dönüşüm Kutusu'na gider
 * (kalıcı silme değil — `deleteAmbient` ile aynı kural).
 */
export async function deleteShortsClip(id, clipId, {
  videosDir = DEFAULT_VIDEOS_DIR,
  probeFn = probe,
  trashFn = moveFileToTrash,
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const existing = status.shorts.clips.find((clip) => clip.id === clipId);
  if (!existing) throw new ApiError(404, `Kesit bulunamadı: ${clipId}`);
  if (runningRender === jobKey(id, clipId)) {
    throw new ApiError(409, 'Bu kesit şu anda render ediliyor.');
  }

  try {
    await removeShortsClip(status.projectPath, clipId);
  } catch (cause) {
    throw new ApiError(422, cause.message);
  }
  if (existing.outputExists) await trashFn(existing.outputPath).catch(() => null);
  renderJobs.delete(jobKey(id, clipId));

  return getShorts(id, { videosDir, probeFn });
}

/**
 * Kesidi render eder (Export). İş arka planda sürer, istek beklemez:
 * 1080×1920 bir kesit dakikalar alabiliyor, HTTP isteği o kadar açık
 * tutulmaz. Durum `GET /api/projects/:id/shorts` → `renders` ile okunur.
 */
export async function startShortsRender(id, clipId, {
  videosDir = DEFAULT_VIDEOS_DIR,
  probeFn = probe,
  exportFn = exportShortsClip,
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  if (runningRender !== null) throw new ShortsRenderRunningError(runningRender);

  const clip = status.shorts.clips.find((item) => item.id === clipId);
  if (!clip) throw new ApiError(404, `Kesit bulunamadı: ${clipId}`);
  if (!status.shorts.source.exists) {
    throw new ApiError(422, `Kaynak video bulunamadı: ${status.shorts.source.path ?? '(tanımsız)'}`);
  }

  const measured = await probeFn(status.shorts.source.path).catch(() => null);
  if (!measured?.width || !measured?.height) {
    throw new ApiError(422, 'Kaynak videonun ölçüsü okunamadı (ffprobe).');
  }

  const key = jobKey(id, clipId);
  const job = {
    projectId: id,
    clipId,
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progressSeconds: 0,
    duration: clip.duration,
    output: clip.output,
    error: null,
  };
  renderJobs.set(key, job);
  runningRender = key;

  // Bilinçli olarak beklenmiyor: istek hemen 202 ile dönüyor.
  void (async () => {
    try {
      await exportFn({
        sourcePath: status.shorts.source.path,
        clip,
        outputPath: clip.outputPath,
        sourceInfo: measured,
        onProgress: (seconds) => { job.progressSeconds = seconds; },
      });
      await markShortsClipRendered(status.projectPath, clipId).catch(() => null);
      Object.assign(job, { state: 'succeeded', finishedAt: new Date().toISOString() });
    } catch (cause) {
      Object.assign(job, {
        state: 'failed',
        error: cause.message,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      runningRender = null;
    }
  })();

  return { ...job };
}

/** Bir projenin render işleri (en son durumlarıyla). */
function listRenders(projectId) {
  const prefix = `${projectId}::`;
  return [...renderJobs.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, job]) => ({ ...job }));
}

/** Testlerin ve sunucu yeniden başlatmalarının bellek kaydını temizlemesi için. */
export function resetShortsRenders() {
  renderJobs.clear();
  runningRender = null;
}

async function sourceDurationOf(status, probeFn) {
  if (!status.shorts.source.exists) return null;
  const measured = await probeFn(status.shorts.source.path).catch(() => null);
  return measured?.duration ?? null;
}

/**
 * Kaynak videoyu akıtır — timeline'daki `<video>` bunu oynatır. Yol
 * project.json'dan geliyor ve ana projenin klasörüne çıkıyor; bu yüzden
 * uzantı denetimi var (keyfi dosya sunulmasın).
 */
export async function getShortsSourceAsset(id, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const path = status.shorts.source.path;
  if (!path || !status.shorts.source.exists) throw new ApiError(404, 'Kaynak video bulunamadı');

  const contentType = SOURCE_MIME_TYPES[extname(path).toLowerCase()];
  if (!contentType) throw new ApiError(400, 'Desteklenmeyen kaynak video biçimi');

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, 'Kaynak video bulunamadı');
  return { path, size: info.size, contentType };
}

/** Render edilmiş kesidi akıtır (önizleme/indirme). */
export async function getShortsClipAsset(id, clipId, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  assertShorts(status, id);

  const clip = status.shorts.clips.find((item) => item.id === clipId);
  if (!clip) throw new ApiError(404, `Kesit bulunamadı: ${clipId}`);
  if (!clip.outputExists) throw new ApiError(404, 'Kesit henüz render edilmedi');

  const info = await stat(clip.outputPath).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, 'Kesit dosyası bulunamadı');
  return { path: clip.outputPath, size: info.size, contentType: 'video/mp4' };
}
