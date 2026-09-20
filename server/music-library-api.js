/**
 * Music Library & Album Management API.
 *
 * Provides endpoints and domain functions for:
 * - Organizing music into albums in a central library (music_library/)
 * - Downloading / ingesting tracks directly from Suno URLs (song, playlist, short link)
 * - Previewing / streaming audio files
 * - Uploading, deleting, and managing tracks and albums
 * - Assigning/exporting tracks from an album to any video project
 */

import { copyFile, mkdir, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AUDIO_EXTENSIONS, listFiles, uniqueFileName } from '../core/files.js';
import { probe } from '../core/probe.js';
import { inspectProject, listProjects } from '../prep/project-status.js';
import { setProjectField } from '../prep/project-file.js';
import { DEFAULT_VIDEOS_DIR } from '../prep/scaffold.js';
import { SunoIngestError } from '../prep/suno-errors.js';
import { ingestSunoUrl, sanitizeFilename } from '../prep/suno-ingest.js';
import { ApiError, openFolderOnOs } from './project-api.js';

export const DEFAULT_MUSIC_DIR = './music_library';

const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

const AUDIO_MIMES = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
};

/**
 * Validates a plain safe single folder or file name (no path separators, no `..`).
 */
export function isSafeName(name) {
  return typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    basename(name) === name;
}

/**
 * Ensures path is strictly inside parent.
 */
function isInside(parent, target) {
  const rel = relative(parent, target);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}

async function realPathInside(parentDir, candidatePath) {
  const [realParent, realCandidate] = await Promise.all([
    realpath(parentDir).catch(() => null),
    realpath(candidatePath).catch(() => null),
  ]);
  return realParent && realCandidate && isInside(realParent, realCandidate) ? realCandidate : null;
}

/**
 * Formats duration in seconds to mm:ss or hh:mm:ss.
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return '0:00';
  const total = Math.round(seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Lists all albums from music_library/ and available projects.
 */
export async function getMusicLibrary({
  musicDir = DEFAULT_MUSIC_DIR,
  videosDir = DEFAULT_VIDEOS_DIR,
  probeFn = probe,
} = {}) {
  const resolvedMusicDir = resolve(musicDir);
  await mkdir(resolvedMusicDir, { recursive: true });

  const entries = await readdir(resolvedMusicDir, { withFileTypes: true }).catch(() => []);
  const albumDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  const albums = [];
  for (const albumId of albumDirs) {
    const albumPath = join(resolvedMusicDir, albumId);
    const audioPaths = await listFiles(albumPath, AUDIO_EXTENSIONS).catch(() => []);

    let totalSize = 0;
    let totalDuration = 0;
    const tracks = [];

    for (const filePath of audioPaths) {
      const file = basename(filePath);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat?.isFile()) continue;

      totalSize += fileStat.size;
      let duration = null;
      try {
        const probed = await probeFn(filePath);
        duration = probed.duration ?? null;
        if (typeof duration === 'number') {
          totalDuration += duration;
        }
      } catch {
        duration = null;
      }

      tracks.push({
        file,
        name: file.replace(/\.[^.]+$/, ''),
        size: fileStat.size,
        duration,
        durationFormatted: duration ? formatDuration(duration) : null,
        previewUrl: `/api/music-library/assets/${encodeURIComponent(albumId)}/${encodeURIComponent(file)}`,
        mtimeMs: fileStat.mtimeMs,
      });
    }

    albums.push({
      id: albumId,
      name: albumId,
      path: albumPath,
      trackCount: tracks.length,
      totalSize,
      totalDuration,
      totalDurationFormatted: formatDuration(totalDuration),
      tracks,
    });
  }

  // Also list available projects for assigning music
  const projectSummaries = await listProjects(videosDir).catch(() => []);
  const projects = projectSummaries.map((p) => ({
    id: p.name,
    name: p.name,
    step: p.step,
  }));

  return {
    musicDir: resolvedMusicDir,
    albums,
    projects,
  };
}

/**
 * Creates a new album folder in music_library/.
 */
export async function createAlbum(body, { musicDir = DEFAULT_MUSIC_DIR } = {}) {
  const rawName = body?.name;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw new ApiError(400, 'Album name is required');
  }

  const safeName = sanitizeFilename(rawName.trim());
  if (!safeName || !isSafeName(safeName)) {
    throw new ApiError(400, 'Invalid album name');
  }

  const resolvedMusicDir = resolve(musicDir);
  await mkdir(resolvedMusicDir, { recursive: true });
  const albumPath = join(resolvedMusicDir, safeName);

  const alreadyExists = await stat(albumPath).then(() => true, () => false);
  if (alreadyExists) {
    throw new ApiError(409, `Album "${safeName}" already exists`);
  }

  await mkdir(albumPath, { recursive: true });
  return {
    id: safeName,
    name: safeName,
    path: albumPath,
    trackCount: 0,
    totalSize: 0,
    totalDuration: 0,
    tracks: [],
  };
}

/**
 * Deletes an entire album folder from music_library/.
 */
export async function deleteAlbum(albumId, { musicDir = DEFAULT_MUSIC_DIR } = {}) {
  if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');

  const resolvedMusicDir = resolve(musicDir);
  const albumPath = join(resolvedMusicDir, albumId);

  const realAlbum = await realPathInside(resolvedMusicDir, albumPath);
  if (!realAlbum) throw new ApiError(404, 'Album not found');

  await rm(realAlbum, { recursive: true, force: true });
  return { ok: true, id: albumId };
}

/**
 * Deletes a single track from an album.
 */
export async function deleteAlbumTrack(albumId, filename, { musicDir = DEFAULT_MUSIC_DIR } = {}) {
  if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');
  if (!isSafeName(filename)) throw new ApiError(400, 'Invalid filename');

  const resolvedMusicDir = resolve(musicDir);
  const trackPath = join(resolvedMusicDir, albumId, filename);

  const realTrack = await realPathInside(resolvedMusicDir, trackPath);
  if (!realTrack) throw new ApiError(404, 'Track not found');

  await unlink(realTrack).catch(() => null);
  return { ok: true, albumId, filename };
}

/**
 * Uploads an audio file into an album.
 */
export async function uploadAlbumTrack(albumId, body, { musicDir = DEFAULT_MUSIC_DIR } = {}) {
  if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');

  const { name, data } = body ?? {};
  if (typeof name !== 'string' || !isSafeName(name)) {
    throw new ApiError(400, 'Invalid track name');
  }
  if (typeof data !== 'string' || data.trim() === '') {
    throw new ApiError(400, 'Audio data is empty');
  }

  const ext = extname(name).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) {
    throw new ApiError(400, `Unsupported audio extension (${ext}). Supported: ${AUDIO_EXTENSIONS.join(', ')}`);
  }

  const resolvedMusicDir = resolve(musicDir);
  const albumPath = join(resolvedMusicDir, albumId);
  const realAlbum = await realPathInside(resolvedMusicDir, albumPath);
  if (!realAlbum) {
    throw new ApiError(404, 'Album not found');
  }

  const base64Clean = data.includes(',') ? data.split(',')[1] : data;
  const buffer = Buffer.from(base64Clean, 'base64');
  if (buffer.length === 0) {
    throw new ApiError(400, 'Audio data is empty');
  }
  if (buffer.length > MAX_AUDIO_UPLOAD_BYTES) {
    throw new ApiError(422, 'Audio file exceeds 100 MB limit');
  }

  const uniqueName = await uniqueFileName(realAlbum, name);
  const targetPath = join(realAlbum, uniqueName);
  await writeFile(targetPath, buffer);

  return {
    ok: true,
    albumId,
    file: uniqueName,
  };
}

/**
 * Opens album or music directory in OS Explorer.
 */
export async function openMusicFolder(body = {}, {
  musicDir = DEFAULT_MUSIC_DIR,
  openFn = openFolderOnOs,
} = {}) {
  const { albumId } = body ?? {};
  const resolvedMusicDir = resolve(musicDir);
  await mkdir(resolvedMusicDir, { recursive: true });

  let targetPath = resolvedMusicDir;
  if (albumId) {
    if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');
    targetPath = join(resolvedMusicDir, albumId);
    await mkdir(targetPath, { recursive: true });
  }

  const ok = openFn(targetPath);
  return { ok, path: targetPath };
}

/**
 * Ingests music directly from Suno URL into an Album or Video Project.
 */
export async function ingestSuno(body, {
  musicDir = DEFAULT_MUSIC_DIR,
  videosDir = DEFAULT_VIDEOS_DIR,
  ingestFn = ingestSunoUrl,
} = {}) {
  const { url, targetType, targetId, newAlbumName } = body ?? {};
  if (typeof url !== 'string' || url.trim() === '') {
    throw new ApiError(400, 'Suno URL is required');
  }

  if (targetType !== 'album' && targetType !== 'project') {
    throw new ApiError(400, 'targetType must be "album" or "project"');
  }

  const resolvedMusicDir = resolve(musicDir);
  await mkdir(resolvedMusicDir, { recursive: true });

  let outputDir;
  let finalAlbumId = null;
  let finalProjectId = null;
  let projectStatus = null;

  if (targetType === 'album') {
    let albumName = targetId;
    if (newAlbumName && typeof newAlbumName === 'string' && newAlbumName.trim()) {
      albumName = sanitizeFilename(newAlbumName.trim());
    }
    if (!albumName || !isSafeName(albumName)) {
      throw new ApiError(400, 'Valid album name or targetId is required');
    }
    finalAlbumId = albumName;
    outputDir = join(resolvedMusicDir, albumName);
    await mkdir(outputDir, { recursive: true });
  } else {
    if (typeof targetId !== 'string' || !isSafeName(targetId)) {
      throw new ApiError(400, 'Valid project targetId is required');
    }
    finalProjectId = targetId;
    const projectDir = join(resolve(videosDir), targetId);
    projectStatus = await inspectProject(projectDir).catch(() => null);
    if (!projectStatus || !projectStatus.projectJson.ok) {
      throw new ApiError(404, `Project "${targetId}" not found or project.json is invalid`);
    }
    outputDir = projectStatus.audioDir;
    await mkdir(outputDir, { recursive: true });
  }

  let ingestResult;
  try {
    ingestResult = await ingestFn({ url: url.trim(), outputDir });
  } catch (error) {
    if (error instanceof SunoIngestError) {
      if (error.notPublic) {
        throw new ApiError(422, `Suno linki public değil ya da içerik bulunamadı: ${error.message}`);
      }
      if (error.downloadDisabled) {
        throw new ApiError(422, `Suno bu şarkı için indirmeyi kapatmış: ${error.message}`);
      }
      throw new ApiError(422, `Suno indirme hatası: ${error.message}`);
    }
    throw new ApiError(502, `Suno bağlantı hatası: ${error.message}`);
  }

  // If target was a project, automatically link tracks in project.json
  if (targetType === 'project' && projectStatus && ingestResult?.tracks?.length > 0) {
    const musicData = projectStatus.projectJson.data?.music ?? {};
    if (Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
      const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
      const count = Math.min(ingestResult.tracks.length, pendingTracks.length);
      for (let i = 0; i < count; i++) {
        pendingTracks[i].status = 'completed';
        pendingTracks[i].file = basename(ingestResult.tracks[i].localPath);
      }
      musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
      musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
      await setProjectField(projectStatus.projectPath, 'music', musicData);
    }
  }

  return {
    ok: true,
    targetType,
    albumId: finalAlbumId,
    projectId: finalProjectId,
    downloadedCount: ingestResult?.tracks?.length ?? 0,
    tracks: (ingestResult?.tracks ?? []).map((t) => ({
      index: t.index,
      title: t.title,
      file: basename(t.localPath),
      duration: t.duration,
    })),
  };
}

/**
 * Assigns / copies tracks from an album to a project's audio/ folder.
 */
export async function assignAlbumToProject(body, {
  musicDir = DEFAULT_MUSIC_DIR,
  videosDir = DEFAULT_VIDEOS_DIR,
} = {}) {
  const { albumId, projectId, trackFiles } = body ?? {};
  if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');
  if (!isSafeName(projectId)) throw new ApiError(400, 'Invalid project id');

  const resolvedMusicDir = resolve(musicDir);
  const albumPath = join(resolvedMusicDir, albumId);
  const realAlbum = await realPathInside(resolvedMusicDir, albumPath);
  if (!realAlbum) throw new ApiError(404, 'Album not found');

  const projectDir = join(resolve(videosDir), projectId);
  const status = await inspectProject(projectDir).catch(() => null);
  if (!status || !status.projectJson.ok) {
    throw new ApiError(404, 'Project not found');
  }

  const allAlbumTracks = await listFiles(realAlbum, AUDIO_EXTENSIONS).catch(() => []);
  const selectedPaths = Array.isArray(trackFiles) && trackFiles.length > 0
    ? allAlbumTracks.filter((p) => trackFiles.includes(basename(p)))
    : allAlbumTracks;

  if (selectedPaths.length === 0) {
    throw new ApiError(422, 'No audio files found in album to assign');
  }

  await mkdir(status.audioDir, { recursive: true });
  const copiedFiles = [];

  for (const srcPath of selectedPaths) {
    const originalName = basename(srcPath);
    const destName = await uniqueFileName(status.audioDir, originalName);
    const destPath = join(status.audioDir, destName);
    await copyFile(srcPath, destPath);
    copiedFiles.push(destName);
  }

  // Update project.json music tracks if music plan exists
  const musicData = status.projectJson.data?.music;
  if (musicData && Array.isArray(musicData.tracks) && musicData.tracks.length > 0) {
    const pendingTracks = musicData.tracks.filter((t) => t.status === 'pending');
    const count = Math.min(copiedFiles.length, pendingTracks.length);
    for (let i = 0; i < count; i++) {
      pendingTracks[i].status = 'completed';
      pendingTracks[i].file = copiedFiles[i];
    }
    musicData.completedCount = musicData.tracks.filter((t) => t.status === 'completed').length;
    musicData.status = musicData.completedCount === musicData.totalTracks ? 'completed' : 'in_progress';
    await setProjectField(status.projectPath, 'music', musicData);
  }

  return {
    ok: true,
    copiedCount: copiedFiles.length,
    copiedFiles,
  };
}

/**
 * Fetches an audio asset for streaming / preview with Range header support.
 */
export async function getMusicAsset(albumId, filename, { musicDir = DEFAULT_MUSIC_DIR } = {}) {
  if (!isSafeName(albumId)) throw new ApiError(400, 'Invalid album id');
  if (!isSafeName(filename)) throw new ApiError(400, 'Invalid filename');

  const ext = extname(filename).toLowerCase();
  const contentType = AUDIO_MIMES[ext];
  if (!contentType) throw new ApiError(400, 'Unsupported audio asset format');

  const resolvedMusicDir = resolve(musicDir);
  const trackPath = join(resolvedMusicDir, albumId, filename);
  const realTrack = await realPathInside(resolvedMusicDir, trackPath);
  if (!realTrack) throw new ApiError(404, 'Audio asset not found');

  const info = await stat(realTrack).catch(() => null);
  if (!info?.isFile()) throw new ApiError(404, 'Audio asset not found');

  return {
    path: realTrack,
    size: info.size,
    contentType,
  };
}
