import type {
  BuildJob,
  ProjectMusicInfo,
  CreateProjectPayload,
  CreateProjectResponse,
  LibraryResponse,
  MimiGalleryResponse,
  ShortsClipPayload,
  ShortsRenderJob,
  ShortsState,
  ProjectAmbient,
  ProjectLabels,
  ProjectPomodoro,
  ProjectDetail,
  UpdateLabelsPayload,
  LibraryPrompt,
  UpdateAmbientPayload,
  UpdatePomodoroPayload,
  ProjectSummary,
  PromptLibraryResponse,
  PromptPayload,
  VideoSource,
  VideoSourceResponse,
} from './types';
import { pomodoroPayload } from './pomodoroSetup';

export class ApiError extends Error {
  status: number;
  details: Record<string, unknown>;
  problems?: string[];
  missing?: string[];

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    if (Array.isArray(details.problems)) {
      this.problems = details.problems as string[];
    }
    if (Array.isArray(details.missing)) {
      this.missing = details.missing as string[];
    }
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found.');
    this.name = 'ProjectNotFoundError';
  }
}

async function handleResponse<T>(response: Response, defaultMessage: string): Promise<T> {
  if (!response.ok) {
    let errorData: Record<string, unknown> | null = null;
    try {
      errorData = (await response.json()) as Record<string, unknown>;
    } catch {
      // JSON parse error fallback
    }
    const message = (typeof errorData?.error === 'string' && errorData.error) || defaultMessage;
    if (response.status === 404 && defaultMessage === 'Could not load project.') {
      throw new ProjectNotFoundError();
    }
    throw new ApiError(response.status, message, errorData || {});
  }
  return response.json() as Promise<T>;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function sendJson<T>(method: string, path: string, body: unknown, defaultMessage: string): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(response, defaultMessage);
}

const projectUrl = (id: string, suffix: string) => `/api/projects/${encodeURIComponent(id)}/${suffix}`;

export async function fetchProjects(): Promise<ProjectSummary[]> {
  const response = await fetch('/api/projects');
  return handleResponse<ProjectSummary[]>(response, 'Projects could not be loaded.');
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`);
  return handleResponse<ProjectDetail>(response, 'Could not load project.');
}

export async function fetchLibrary(): Promise<LibraryResponse> {
  const response = await fetch('/api/library');
  return handleResponse<LibraryResponse>(response, 'Library could not be loaded.');
}

export async function createProject(payload: CreateProjectPayload): Promise<CreateProjectResponse> {
  const response = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<CreateProjectResponse>(response, 'Project could not be created.');
}

export type SelectClipPayload = {
  file: string;
  cropBottom?: number;
  watermark?: boolean;
};

export async function selectProjectClip(
  id: string,
  payload: string | SelectClipPayload,
): Promise<ProjectDetail> {
  const body = typeof payload === 'string' ? { file: payload } : payload;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(id)}/clip`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await handleResponse<ProjectDetail>(response, 'Clip could not be selected.');
  } catch (err: unknown) {
    if (
      err instanceof ApiError &&
      err.status === 400 &&
      typeof err.message === 'string' &&
      err.message.includes('Unknown field') &&
      body.file
    ) {
      const fallbackResponse = await fetch(`/api/projects/${encodeURIComponent(id)}/clip`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: body.file }),
      });
      return await handleResponse<ProjectDetail>(fallbackResponse, 'Clip could not be selected.');
    }
    throw err;
  }
}

export const updateProjectClipSettings = selectProjectClip;

export async function completeProjectMusic(id: string): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/music/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return handleResponse<ProjectDetail>(response, 'Music could not be completed.');
}

/**
 * Montajı başlatır. `render` verilmezse sunucu uzun videoyu da üretir —
 * "5. Montaj" adımı çıktı dosyasını görünce tamamlanıyor.
 */
export async function startBuild(
  id: string,
  options: { overwrite?: boolean; render?: boolean } = {},
): Promise<BuildJob> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  return handleResponse<BuildJob>(response, 'Build could not be started.');
}

export async function fetchBuildStatus(id: string): Promise<BuildJob> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/build`);
  return handleResponse<BuildJob>(response, 'Build status could not be loaded.');
}

export type UpdateCropPayload = {
  watermark?: boolean;
  cropBottom?: number;
  cropTop?: number;
  cropLeft?: number;
  cropRight?: number;
  aspect?: string;
};

export async function updateProjectCrop(
  id: string,
  payload: UpdateCropPayload,
): Promise<ProjectDetail> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/crop`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<ProjectDetail>(response, 'Crop settings could not be updated.');
}

// ------------------------------------------------- prompt kütüphanesi (projeden bağımsız)

const promptUrl = (id: string) => `/api/prompts/${encodeURIComponent(id)}`;

/** Kütüphanedeki tüm promptlar, etiket listesi ve alan sınırları. */
export async function fetchPromptLibrary(): Promise<PromptLibraryResponse> {
  const response = await fetch('/api/prompts');
  return handleResponse<PromptLibraryResponse>(response, 'Prompts could not be loaded.');
}

/** Yeni prompt ekler; kimlik başlıktan türetilir. */
export async function createLibraryPrompt(payload: PromptPayload): Promise<{ prompt: LibraryPrompt }> {
  return sendJson('POST', '/api/prompts', payload, 'Prompt could not be saved.');
}

/** Var olan promptu günceller; verilmeyen alanlar korunur. */
export async function updateLibraryPrompt(
  id: string,
  payload: PromptPayload,
): Promise<{ prompt: LibraryPrompt }> {
  return sendJson('PUT', promptUrl(id), payload, 'Prompt could not be updated.');
}

export async function deleteLibraryPrompt(id: string): Promise<{ ok: boolean; deleted: string }> {
  const response = await fetch(promptUrl(id), { method: 'DELETE' });
  return handleResponse(response, 'Prompt could not be deleted.');
}

/**
 * Metni panoya kopyalar. Pano API'si yalnızca güvenli bağlamda ve izinle
 * çalışır; reddedilirse gizli bir textarea + execCommand ile denenir, o da
 * olmazsa false döner ve arayüz metni seçtirir.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * Görsel kaynağını değiştirir: tek resim ↔ döngü videosu. Yeni moda uymayan
 * seçim sunucuda boşaltılır; ne olduğu `videoSourceChange` altında döner.
 */
export async function updateProjectVideoSource(
  id: string,
  source: VideoSource,
): Promise<VideoSourceResponse> {
  return sendJson<VideoSourceResponse>(
    'PUT',
    projectUrl(id, 'video-source'),
    { source },
    'Video source could not be changed.',
  );
}

/** Projenin Ambiance seçimi + ortak klasördeki bütün sesler. */
export async function fetchProjectAmbient(id: string): Promise<ProjectAmbient> {
  const response = await fetch(projectUrl(id, 'ambient'));
  return handleResponse<ProjectAmbient>(response, 'Ambiance selection could not be loaded.');
}

/**
 * Ambiance seçimini yazar. Parçalar kütüphanedeki ADLARIYLA gönderilir;
 * dosya yolunu sunucu çözer. Boş `tracks` seçimi kaldırır.
 */
export async function updateProjectAmbient(
  id: string,
  payload: UpdateAmbientPayload,
): Promise<ProjectAmbient> {
  return sendJson<ProjectAmbient>(
    'PUT',
    projectUrl(id, 'ambient'),
    payload,
    'Ambiance selection could not be saved.',
  );
}

/** Projenin video üstü etiketleri + önizleme için kadraj oranı ve oturum zamanları. */
export async function fetchProjectLabels(id: string): Promise<ProjectLabels> {
  const response = await fetch(projectUrl(id, 'labels'));
  return handleResponse<ProjectLabels>(response, 'Labels could not be loaded.');
}

/**
 * Pomodoro mola görüntüsünü yazar; diğer ayarlar olduğu gibi korunur. Boş metin
 * kaldırır (mola da çalışma görüntüsünü kullanır). Pomodoro kapalıyken çağrılmaz.
 */
export async function setProjectBreakClip(id: string, breakClip: string): Promise<ProjectPomodoro> {
  const current = await fetchProjectPomodoro(id);
  return updateProjectPomodoro(id, pomodoroPayload(current, { breakClip }));
}

/** Etiketleri yazar (boş liste hepsini kaldırır). Pomodoro ayarına dokunmaz. */
export async function updateProjectLabels(
  id: string,
  payload: UpdateLabelsPayload,
): Promise<ProjectLabels> {
  return sendJson<ProjectLabels>('PUT', projectUrl(id, 'labels'), payload, 'Labels could not be saved.');
}

/** Projenin Pomodoro ayarı + montaj öncesi doğrulama sonucu. */
export async function fetchProjectPomodoro(id: string): Promise<ProjectPomodoro> {
  const response = await fetch(projectUrl(id, 'pomodoro'));
  return handleResponse<ProjectPomodoro>(response, 'Pomodoro settings could not be loaded.');
}

/**
 * Pomodoro ayarını yazar ve GÜNCEL doğrulamayı geri alır: ayar değişince
 * "müzik yetiyor mu" cevabı da değişir, ekran ikinci bir istek atmak zorunda
 * kalmasın. `enabled: false` Pomodoro'yu kapatır.
 */
export async function updateProjectPomodoro(
  id: string,
  payload: UpdatePomodoroPayload,
): Promise<ProjectPomodoro> {
  return sendJson<ProjectPomodoro>(
    'PUT',
    projectUrl(id, 'pomodoro'),
    payload,
    'Pomodoro settings could not be saved.',
  );
}

/** Görsel kartlarının küçük resmi: videolar\ ve resimler\ altındaki her dosya (yol ya da ad verilebilir). */
export function getProjectVisualUrl(projectId: string, pathOrName: string): string {
  const name = pathOrName.split(/[\\/]/).pop() || pathOrName;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/visual/${encodeURIComponent(name)}`;
}

export function getProjectClipUrl(projectId: string, clipPathOrName?: string | null): string {
  if (!clipPathOrName) return '';
  const name = clipPathOrName.split(/[\\/]/).pop() || clipPathOrName;
  return `/api/projects/${encodeURIComponent(projectId)}/assets/video/${encodeURIComponent(name)}`;
}

export function getProjectOutputUrl(projectId: string, fileName?: string | null): string {
  const name = (fileName && (fileName.split(/[\\/]/).pop() || fileName)) || 'final_ambient.mp4';
  return `/api/projects/${encodeURIComponent(projectId)}/assets/output/${encodeURIComponent(name)}`;
}

export async function openProjectFolder(
  id: string,
  folder?: string,
): Promise<{ ok: boolean; path: string }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}/open-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(folder ? { folder } : {}),
  });
  return handleResponse<{ ok: boolean; path: string }>(response, 'Folder could not be opened.');
}

/** Proje klasörü Geri Dönüşüm Kutusu'na taşınır (kalıcı silinmez). */
export async function deleteProject(id: string): Promise<{ deleted: string }> {
  const response = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return handleResponse<{ deleted: string }>(response, 'Project could not be deleted.');
}

// ---------------------------------------------------------------- Music Library
// Yalnızca ekranların kullandığı uçlar: kütüphaneyi okumak ve bir albümü
// projeye atamak.
//
// AÇIK İŞ: albüm/parça yönetimi uçları (POST /albums, DELETE /albums/:id,
// DELETE /tracks/:a/:t, /upload, /open-folder, /assets/…) artık
// HİÇBİR yerden çağrılmıyor — eskiden panelin işiydi, panel kaldırıldı. Ya bu
// ekranlar web'e eklenmeli ya da uçlar silinmeli; ikisi de yapılmadan durmasın.

export async function fetchMusicLibrary(): Promise<import('./types').MusicLibraryResponse> {
  const response = await fetch('/api/music-library');
  return handleResponse<import('./types').MusicLibraryResponse>(response, 'Music library could not be loaded.');
}

export async function assignAlbumToProject(payload: {
  albumId: string;
  projectId: string;
  trackFiles?: string[];
}): Promise<{ ok: boolean; copiedCount: number; copiedFiles: string[] }> {
  const response = await fetch('/api/music-library/assign-to-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<{ ok: boolean; copiedCount: number; copiedFiles: string[] }>(
    response,
    'Tracks could not be assigned to project.',
  );
}

// ---------------------------------------------------------------- Canonical workflow steps

export async function fetchProjectMusic(id: string): Promise<ProjectMusicInfo> {
  const response = await fetch(projectUrl(id, 'music'));
  return handleResponse<ProjectMusicInfo>(response, 'Music could not be loaded.');
}

/** Tek resim modunun görselleri → resimler/. Yuva yok: klasördeki her görsel aday. */
export async function uploadProjectImage(id: string, file: File): Promise<ProjectDetail> {
  const data = await readAsDataUrl(file);
  return sendJson<ProjectDetail>(
    'POST',
    projectUrl(id, 'images'),
    { name: file.name, data },
    'Image could not be uploaded.',
  );
}

export async function uploadProjectClip(id: string, file: File): Promise<ProjectDetail> {
  const data = await readAsDataUrl(file);
  return sendJson<ProjectDetail>('POST', projectUrl(id, 'clips'), { name: file.name, data }, 'Video could not be uploaded.');
}

/**
 * Müzik ya da zip yükler. Dosya ham bayt olarak gönderilir (base64/JSON değil): tarayıcı
 * dosyayı diskten akıtır, yüzlerce MB'lık zip bellekte kopyalanmaz.
 */
export async function uploadProjectAudio(id: string, file: File): Promise<ProjectDetail> {
  const response = await fetch(`${projectUrl(id, 'audio')}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  return handleResponse<ProjectDetail>(response, 'Audio could not be uploaded.');
}

/**
 * Ortak Ambiance klasörüne ses yükler.
 *
 * Kütüphanedeki ad dosya adından türetiliyor (uzantısız), bu yüzden
 * kullanıcının yazdığı ad seçilen dosyanın uzantısıyla birleştirilip
 * gönderilir — ad ne yazıldıysa listede o görünür.
 */
export async function uploadAmbient(name: string, file: File): Promise<LibraryResponse> {
  const data = await readAsDataUrl(file);
  const dot = file.name.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.name.slice(dot);
  return sendJson<LibraryResponse>(
    'POST',
    '/api/ambients/upload',
    { name: `${name}${ext}`, data },
    'Ambiance yüklenemedi.',
  );
}

/**
 * Bir Ambiance'ın dinleme adresi.
 *
 * Doğrudan `<audio src>` olarak kullanılır: sunucu aralık (range) isteklerini
 * desteklediği için tarayıcı dosyanın tamamını indirmeden çalmaya başlar ve
 * ileri/geri sarma çalışır.
 */
export const getAmbientAudioUrl = (name: string) =>
  `/api/ambients/${encodeURIComponent(name)}/audio`;

/** Ortak klasördeki bir Ambiance'ı Geri Dönüşüm Kutusu'na yollar. */
export async function deleteAmbient(name: string): Promise<LibraryResponse> {
  return sendJson<LibraryResponse>(
    'DELETE',
    `/api/ambients/${encodeURIComponent(name)}`,
    undefined,
    'Ambiance silinemedi.',
  );
}

export async function saveTrackOrder(
  id: string,
  payload: { mode: 'alphabetical' | 'added' } | { mode: 'manual'; order: string[] },
): Promise<ProjectDetail> {
  return sendJson<ProjectDetail>('PUT', projectUrl(id, 'order'), payload, 'Track order could not be saved.');
}

export async function copyProjectTracks(
  targetId: string,
  payload: { sourceProjectId: string; trackFiles: string[] },
): Promise<{ ok: boolean; copiedCount: number; copiedFiles: string[] }> {
  return sendJson<{ ok: boolean; copiedCount: number; copiedFiles: string[] }>(
    'POST',
    projectUrl(targetId, 'copy-tracks'),
    payload,
    'Tracks could not be copied from source project.',
  );
}

// ------------------------------------------------------------- Mimi galerisi

/** Mimi klasörünün güncel içeriği. */
export async function fetchMimiGallery(): Promise<MimiGalleryResponse> {
  const response = await fetch('/api/mimi');
  return handleResponse<MimiGalleryResponse>(response, 'Mimi galerisi yüklenemedi.');
}

/** Resim/video dosyasını ortak Mimi klasörüne yükler; yanıt galerinin yeni hali. */
export async function uploadMimiAsset(file: File): Promise<MimiGalleryResponse> {
  const data = await readAsDataUrl(file);
  return sendJson<MimiGalleryResponse>(
    'POST',
    '/api/mimi/upload',
    { name: file.name, data },
    'Dosya yüklenemedi.',
  );
}

/** Mimi klasöründeki bir dosyayı Geri Dönüşüm Kutusu'na yollar. */
export async function deleteMimiAsset(file: string): Promise<MimiGalleryResponse> {
  return sendJson<MimiGalleryResponse>(
    'DELETE',
    `/api/mimi/${encodeURIComponent(file)}`,
    undefined,
    'Dosya silinemedi.',
  );
}

/**
 * Bir resmi loop videoya çevirir (sunucuda ffmpeg; `<ad>.loop.mp4`).
 * Video zaten varsa sunucu 409 döner — `overwrite` ile yeniden üretilir.
 */
export async function convertMimiImageToLoop(
  file: string,
  seconds: number,
  overwrite = false,
): Promise<MimiGalleryResponse> {
  return sendJson<MimiGalleryResponse>(
    'POST',
    '/api/mimi/convert-to-loop',
    { file, seconds, overwrite },
    'Loop video üretilemedi.',
  );
}

/** Ortak Mimi klasörünü Explorer'da açar — dosya sürükleyip bırakmak için. */
export async function openMimiFolder(): Promise<{ ok: boolean; path: string }> {
  return sendJson<{ ok: boolean; path: string }>('POST', '/api/mimi/open-folder', {}, 'Klasör açılamadı.');
}

// -------------------------------------------------------------- Shorts (9:16)

const shortsUrl = (id: string, suffix = '') =>
  `/api/projects/${encodeURIComponent(id)}/shorts${suffix}`;

/** Shorts alt projesinin tam durumu (kaynak ölçümü + kesitler + render işleri). */
export async function fetchShorts(id: string): Promise<ShortsState> {
  const response = await fetch(shortsUrl(id));
  return handleResponse<ShortsState>(response, 'Shorts projesi yüklenemedi.');
}

/**
 * Ana projeden Shorts alt projesi açar. Kaynak video kopyalanmaz; alt proje
 * ana projedeki dosyaya yol tutar.
 */
export async function createShortsSubproject(
  parentId: string,
  body: { name?: string; source?: string } = {},
): Promise<ShortsState> {
  return sendJson<ShortsState>(
    'POST',
    `/api/projects/${encodeURIComponent(parentId)}/shorts-subprojects`,
    body,
    'Shorts alt projesi oluşturulamadı.',
  );
}

/** "Bu Aralığı Al" — seçili aralığı yeni kesit olarak ekler. */
export async function addShortsClip(id: string, payload: ShortsClipPayload): Promise<ShortsState> {
  return sendJson<ShortsState>('POST', shortsUrl(id, '/clips'), payload, 'Kesit eklenemedi.');
}

/** Kesidin aralığını/kadrajını/başlığını güncelle. */
export async function updateShortsClip(
  id: string,
  clipId: string,
  payload: Partial<ShortsClipPayload>,
): Promise<ShortsState> {
  return sendJson<ShortsState>(
    'PUT',
    shortsUrl(id, `/clips/${encodeURIComponent(clipId)}`),
    payload,
    'Kesit güncellenemedi.',
  );
}

/** Kesidi siler; render edilmiş dosya Geri Dönüşüm Kutusu'na gider. */
export async function deleteShortsClip(id: string, clipId: string): Promise<ShortsState> {
  return sendJson<ShortsState>(
    'DELETE',
    shortsUrl(id, `/clips/${encodeURIComponent(clipId)}`),
    undefined,
    'Kesit silinemedi.',
  );
}

/** Render başlatır (arka planda sürer; durum fetchShorts → renders'tan okunur). */
export async function renderShortsClip(id: string, clipId: string): Promise<ShortsRenderJob> {
  return sendJson<ShortsRenderJob>(
    'POST',
    shortsUrl(id, `/clips/${encodeURIComponent(clipId)}/render`),
    {},
    'Render başlatılamadı.',
  );
}
