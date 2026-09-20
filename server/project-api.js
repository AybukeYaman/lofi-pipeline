/**
 * Web UI icin proje durum adapter'i.
 *
 * HTTP katmani filesystem ayrintilarini bilmez; mevcut proje-durum
 * fonksiyonlarini bu dar arayuzden kullanir. Yazan islemler panelin
 * (ui/actions.js) kullandigi domain fonksiyonlarinin aynisini cagirir.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  MAX_IMAGE_SIZE_BYTES, SUPPORTED_IMAGE_EXTENSIONS, describeMultiReferenceStyle, getImageMimeType,
} from '../prep/describe-style.js';

import { AddStyleError, runAddStyle } from '../add-style.js';
import { AUDIO_EXTENSIONS, listFiles } from '../core/files.js';
import { probe } from '../core/probe.js';
import { readJsonFile, writeTextFile } from '../core/workspace.js';
import { NewVideoError, runNewVideo } from '../new-video.js';
import { AmbientError, DEFAULT_AMBIENT_DIR, listAmbients } from '../prep/ambients.js';
import { GeminiError, getApiKey, loadEnv } from '../prep/gemini.js';
import {
  DEFAULT_CROP_BOTTOM, ProjectFileError, completeMusicByUser, cropForWatermark, setProjectClip, setProjectCrop, setProjectCropBottom,
  setProjectField,
} from '../prep/project-file.js';
import {
  ANGLE_PATTERN, MASTER_PATTERN, SCENE_REF_PATTERN, canonicalWorkflow, inspectProject, isMusicCompleted, listProjects, nextStep,
} from '../prep/project-status.js';
import {
  ProjectStyleError, StyleGenerationError, generateProjectStyle, projectPromptStyle,
} from '../prep/project-style.js';
import { codeBlocks, getPhasePrompts } from '../prep/prompts.js';
import { DEFAULT_VIDEOS_DIR, ProjectExistsError, validateVideoName } from '../prep/scaffold.js';
import {
  CUSTOM_STYLE_NAME, STYLES_DIR, STYLE_NAME_PATTERN, StyleError, findStyleRef, findStyleRefs, listStyles, loadStyle, validateStyle,
} from '../prep/styles.js';
import { REPO_ROOT } from './build-jobs.js';

/** Albümdeki parça sayısı sınırı — music-planner ile aynı aralık. */
const MAX_TRACKS = 50;
const MAX_CONCEPT_LENGTH = 300;
/**
 * Önizlenebilen asset türleri: projedeki izinli dosyalar (inspectProject'ten)
 * ve türün sunabileceği MIME ailesi (ör. MASTER.txt master olarak sunulmaz).
 */
const ASSET_TYPES = {
  master: { kind: 'image/', files: (status) => (status.master ? [status.master] : []) },
  scene: { kind: 'image/', files: (status) => (status.sceneRef ? [status.sceneRef] : []) },
  angle: { kind: 'image/', files: (status) => status.angles },
  reference: {
    kind: 'image/',
    files: (status) => [...status.references, ...(status.styleRef ? [status.styleRef] : [])],
  },
  clip: { kind: 'video/', files: (status) => (status.clip.exists ? [status.clip.path] : []) },
  /** Seçim ekranı: selectClip'in kabul ettiği videolar/*.mp4 */
  video: { kind: 'video/', files: (status) => status.clips },
  /** Müzik: audioDir'deki ses dosyaları (inspectProject'in audioCount'u ile aynı liste). */
  audio: { kind: 'audio/', files: (status) => audioFilesOf(status) },
  output: { kind: 'video/', files: (status) => (status.output.exists ? [status.output.path] : []) },
  tracklist: {
    kind: 'text/',
    files: (status) => (status.output.tracklistExists ? [status.output.tracklistPath] : []),
  },
};
const ASSET_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
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
/** Süren Gemini üretimleri (proje stili, kütüphane stili): aynı hedefe ikinci istek 409. */
const runningGenerations = new Set();

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
  return projects.map(({ name, mtimeMs, step, workflow }) => ({
    id: name,
    name,
    mtimeMs,
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
    workflow: canonicalWorkflow(status),
    readiness,
  };
}

/**
 * Yeni proje — panelin kullandigi runNewVideo (new-video.js) ile.
 *
 * @param {unknown} body `{ name, style, ambient?, concept?, totalTracks? }`
 * @returns {Promise<{ project: object, warnings: string[] }>}
 */
export async function createProject(body, {
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  stylesDir = STYLES_DIR,
  runNewVideoFn = runNewVideo,
} = {}) {
  const input = parseCreateBody(body);
  // Panel gibi: isim geçerliyse klasörü önceden kontrol et — müzik planı
  // (GEMINI_API_KEY varsa ağ isteği) boşuna üretilmesin. Yarışı writeProject yakalar.
  if (validateVideoName(input.name).length === 0 && await exists(join(videosDir, input.name))) {
    throw new ApiError(409, 'Project already exists');
  }

  let result;
  try {
    result = await runNewVideoFn({
      videoName: input.name,
      styleName: input.style,
      ambientName: input.ambient.length > 0 ? input.ambient : undefined,
      concept: input.concept,
      totalTracks: input.totalTracks,
      videosDir,
      ambientDir,
      stylesDir,
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

  return {
    project: await getProject(input.name, { videosDir }),
    warnings: result.warnings,
  };
}

/** Stil ve ambient kutuphanesi — panelin "Settings" ekraninin verisi. */
export async function getLibrary({ stylesDir = STYLES_DIR, ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  let ambients = [];
  let ambientError = null;
  try {
    ambients = await listAmbients(ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    ambientError = error.message;
  }

  const styles = [{
    name: CUSTOM_STYLE_NAME,
    kind: 'custom',
    valid: true,
    suggestedAmbient: null,
    hasReference: false,
  }];
  for (const name of await listStyles({ dir: stylesDir })) {
    styles.push(await describeLibraryStyle(name, { stylesDir, ambients }));
  }

  return {
    styles,
    ambients: ambients.map((ambient) => ({ name: ambient.name })),
    ambientError,
  };
}

/**
 * Stilin referans görsellerini kaydeder.
 */
async function saveStyleReferences(name, refInput, stylesDir) {
  const refsDir = join(stylesDir, 'refs');
  await mkdir(refsDir, { recursive: true });

  const refList = Array.isArray(refInput)
    ? refInput
    : refInput && typeof refInput === 'object'
      ? [refInput]
      : [];

  if (refList.length === 0) return [];

  const existingRefs = await findStyleRefs(name, { dir: stylesDir });
  for (const p of existingRefs.paths) {
    await unlink(p).catch(() => {});
  }

  const savedPaths = [];
  for (let i = 0; i < refList.length; i++) {
    const ref = refList[i];
    if (typeof ref === 'object' && ref !== null && typeof ref.data === 'string' && ref.data) {
      const originalName = typeof ref.name === 'string' ? ref.name : `ref-${i + 1}.png`;
      const ext = extname(originalName).toLowerCase() || '.png';
      if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
        const buffer = decodeUpload(ref.data, MAX_IMAGE_SIZE_BYTES, `Reference image ${originalName}`);
        const saveFilename = i === 0 ? `${name}${ext}` : `${name}-${i + 1}${ext}`;
        const targetPath = join(refsDir, saveFilename);
        await writeFile(targetPath, buffer);
        savedPaths.push(targetPath);
      }
    }
  }
  return savedPaths;
}

/**
 * Kutuphaneye stil ekler — add-style.js (runAddStyle) ile veya dogrudan stil tanimiyla.
 *
 * @param {unknown} body `{ name, projectId?, reference?, styleBlock?, suggestedAmbient?, motionHints?, music?, referenceImages?, referenceImage?, overwrite? }`
 * @param {{ gemini?: object, videosDir?: string, stylesDir?: string, ambientDir?: string }} [options]
 * @returns {Promise<{ style: object }>} GET /api/library'deki stil girdisiyle ayni bicim
 */
export async function createLibraryStyle(body, {
  videosDir = DEFAULT_VIDEOS_DIR,
  stylesDir = STYLES_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  gemini = {},
} = {}) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const overwrite = Boolean(body?.overwrite);
  if (!STYLE_NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'name must be lowercase kebab-case (e.g. neo-tokyo)');
  }
  if (name === CUSTOM_STYLE_NAME) throw new ApiError(400, `name "${CUSTOM_STYLE_NAME}" is reserved`);

  return exclusive(`style:${name}`, async () => {
    const stylePath = join(stylesDir, `${name}.json`);
    if (!overwrite && (await listStyles({ dir: stylesDir })).includes(name)) {
      throw new ApiError(409, 'Style already exists', { name });
    }

    const ambients = await ambientsOrEmpty(ambientDir);

    // Direct manual style definition
    if (body.styleBlock && typeof body.styleBlock === 'object') {
      const newStyle = {
        name,
        styleBlock: body.styleBlock,
        suggestedAmbient: typeof body.suggestedAmbient === 'string'
          ? body.suggestedAmbient
          : Array.isArray(body.suggestedAmbient) && body.suggestedAmbient.length > 0
            ? body.suggestedAmbient[0]
            : 'gentleRain',
        motionHints: Array.isArray(body.motionHints) ? body.motionHints : [],
        music: body.music || undefined,
      };
      const { problems } = validateStyle(newStyle, { expectedName: name, ambients });
      if (problems.length > 0) {
        throw new ApiError(422, 'Style validation failed', { problems });
      }
      await writeTextFile(stylePath, JSON.stringify(newStyle, null, 2) + '\n');
      if (body.referenceImages || body.referenceImage) {
        await saveStyleReferences(name, body.referenceImages || body.referenceImage, stylesDir);
      }
      return { style: await describeLibraryStyle(name, { stylesDir, ambients }) };
    }

    // AI synthesis from project reference image
    if (body.projectId !== undefined || body.reference !== undefined) {
      const { projectId, reference } = parseBody(
        body,
        { name: 'string', projectId: 'string', reference: 'string', overwrite: 'boolean' },
        ['name', 'projectId', 'reference'],
      );
      if (!isPlainName(reference)) throw new ApiError(400, 'Invalid reference');
      const projectDir = await resolveProjectDir(projectId, videosDir);

      const status = await inspectProject(projectDir);
      const candidates = ASSET_TYPES.reference.files(status);
      const source = candidates.find((path) => basename(path) === reference);
      const imagePath = source && await realPathInside(projectDir, source);
      if (!imagePath) {
        throw new ApiError(422, 'Reference image not found in the project', {
          available: candidates.map((path) => basename(path)),
        });
      }

      const options = geminiOptions(gemini);
      try {
        await runAddStyle({ imagePath, name, overwrite, ambientDir, stylesDir, options });
      } catch (error) {
        if (error instanceof AddStyleError) {
          throw new ApiError(422, 'Style could not be generated', { problem: error.message });
        }
        throw generationApiError(error);
      }
      return { style: await describeLibraryStyle(name, { stylesDir, ambients }) };
    }

    // AI synthesis from concept and/or uploaded reference images (Style Library modal)
    const normalizedBody = {
      ...body,
      suggestedAmbient: typeof body?.suggestedAmbient === 'string'
        ? [body.suggestedAmbient]
        : body?.suggestedAmbient,
    };
    const input = parseBody(
      normalizedBody,
      { name: 'string', concept: 'string', referenceImages: 'array', suggestedAmbient: 'array', overwrite: 'boolean' },
      ['name'],
    );

    const options = geminiOptions(gemini);
    const concept = typeof input.concept === 'string' ? input.concept.trim() : '';
    const referenceImages = Array.isArray(input.referenceImages) ? input.referenceImages : [];

    const rawImages = [];
    const refsDir = join(stylesDir, 'refs');
    await mkdir(refsDir, { recursive: true });

    if (overwrite) {
      const existingRefs = await findStyleRefs(name, { dir: stylesDir });
      for (const p of existingRefs.paths) {
        await unlink(p).catch(() => {});
      }
    }

    for (let i = 0; i < referenceImages.length; i++) {
      const ref = referenceImages[i];
      if (typeof ref === 'object' && ref !== null && typeof ref.data === 'string' && ref.data) {
        const refName = typeof ref.name === 'string' ? ref.name : `ref-${i + 1}.png`;
        const ext = extname(refName).toLowerCase() || '.png';
        if (SUPPORTED_IMAGE_EXTENSIONS.includes(ext)) {
          const buffer = decodeUpload(ref.data, MAX_IMAGE_SIZE_BYTES, `Reference image ${refName}`);
          const mimeType = getImageMimeType(ext);
          if (mimeType) {
            rawImages.push({ mimeType, buffer });
            const saveFilename = i === 0 ? `${name}${ext}` : `${name}-${i + 1}${ext}`;
            await writeFile(join(refsDir, saveFilename), buffer);
          }
        }
      }
    }

    try {
      const result = await describeMultiReferenceStyle({
        imagePaths: [],
        rawImages,
        concept,
        name,
        options: { ambientDir, ...options },
      });

      const newStyle = {
        ...result.style,
        suggestedAmbient: (Array.isArray(input.suggestedAmbient) && input.suggestedAmbient.length > 0)
          ? input.suggestedAmbient[0]
          : (result.style.suggestedAmbient || (ambients[0]?.name ?? 'gentleRain')),
      };

      const { problems } = validateStyle(newStyle, { expectedName: name, ambients });
      if (problems.length > 0) {
        throw new ApiError(422, 'Style validation failed', { problems });
      }

      await writeTextFile(stylePath, JSON.stringify(newStyle, null, 2) + '\n');
      return { style: await describeLibraryStyle(name, { stylesDir, ambients }) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw generationApiError(error);
    }
  });
}

/**
 * Tek bir stilin ayrintisini dondurur.
 */
export async function getStyle(name, { stylesDir = STYLES_DIR, ambientDir = DEFAULT_AMBIENT_DIR } = {}) {
  if (name === CUSTOM_STYLE_NAME) {
    return {
      name: CUSTOM_STYLE_NAME,
      kind: 'custom',
      valid: true,
      suggestedAmbient: null,
      hasReference: false,
    };
  }
  const exists = (await listStyles({ dir: stylesDir })).includes(name);
  if (!exists) {
    throw new ApiError(404, `Style "${name}" not found`);
  }
  const ambients = await ambientsOrEmpty(ambientDir);
  const detail = await describeLibraryStyle(name, { stylesDir, ambients });
  return detail;
}

/**
 * Var olan stili gunceller (yeniden adlandirma dahil).
 */
export async function updateLibraryStyle(name, body, {
  stylesDir = STYLES_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  gemini = {},
} = {}) {
  if (name === CUSTOM_STYLE_NAME) {
    throw new ApiError(400, `Style "${CUSTOM_STYLE_NAME}" is reserved and cannot be modified`);
  }
  if (!STYLE_NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'name must be lowercase kebab-case (e.g. neo-tokyo)');
  }

  const targetName = (typeof body?.name === 'string' && body.name.trim() !== '') ? body.name.trim() : name;
  if (!STYLE_NAME_PATTERN.test(targetName)) {
    throw new ApiError(400, 'name must be lowercase kebab-case (e.g. neo-tokyo)');
  }
  if (targetName === CUSTOM_STYLE_NAME) {
    throw new ApiError(400, `name "${CUSTOM_STYLE_NAME}" is reserved`);
  }

  return exclusive(`style:${name}`, async () => {
    const stylePath = join(stylesDir, `${name}.json`);
    const exists = (await listStyles({ dir: stylesDir })).includes(name);
    if (!exists) {
      throw new ApiError(404, `Style "${name}" not found`);
    }

    if (targetName !== name) {
      const targetExists = (await listStyles({ dir: stylesDir })).includes(targetName);
      if (targetExists) {
        throw new ApiError(409, `Style with name "${targetName}" already exists`);
      }
    }

    const ambients = await ambientsOrEmpty(ambientDir);
    const existing = await readJsonFile(stylePath).catch(() => ({}));

    // Handle new reference image(s) upload during edit if provided
    const refList = body.referenceImages !== undefined
      ? body.referenceImages
      : body.referenceImage !== undefined
        ? (body.referenceImage ? [body.referenceImage] : [])
        : undefined;

    if (refList !== undefined) {
      await saveStyleReferences(targetName, refList, stylesDir);
      if (targetName !== name) {
        const oldRefs = await findStyleRefs(name, { dir: stylesDir });
        for (const p of oldRefs.paths) await unlink(p).catch(() => {});
      }
    } else if (targetName !== name) {
      // If renamed without replacing images, move ALL existing ref images
      const refsDir = join(stylesDir, 'refs');
      const oldRefs = await findStyleRefs(name, { dir: stylesDir });
      for (const oldPath of oldRefs.paths) {
        const oldFilename = basename(oldPath);
        const newFilename = oldFilename.startsWith(name)
          ? `${targetName}${oldFilename.slice(name.length)}`
          : `${targetName}-${oldFilename}`;
        const newPath = join(refsDir, newFilename);
        await writeFile(newPath, await readFile(oldPath));
        await unlink(oldPath).catch(() => {});
      }
    }

    let updated;

    // Eğer regenerate: true ise Gemini ile referans görsellerden yeniden analiz yap
    if (body.regenerate === true) {
      const { paths: refPaths } = await findStyleRefs(targetName !== name ? targetName : name, { dir: stylesDir });
      if (refPaths.length === 0) {
        throw new ApiError(422, 'No reference images found for regeneration. Please add at least one reference image.');
      }

      const options = geminiOptions(gemini);
      try {
        const result = await describeMultiReferenceStyle({
          imagePaths: refPaths,
          rawImages: [],
          concept: typeof body.concept === 'string' ? body.concept.trim() : '',
          name: targetName !== name ? targetName : name,
          options: { ambientDir, ...options },
        });

        updated = {
          ...existing,
          name: targetName,
          styleBlock: result.style.styleBlock ?? existing.styleBlock,
          suggestedAmbient: result.style.suggestedAmbient ?? existing.suggestedAmbient,
          motionHints: result.style.motionHints ?? existing.motionHints,
          music: body.music !== undefined ? body.music : existing.music,
        };
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw generationApiError(error);
      }
    } else {
      updated = {
        ...existing,
        name: targetName,
        styleBlock: body.styleBlock !== undefined ? body.styleBlock : existing.styleBlock,
        suggestedAmbient: body.suggestedAmbient !== undefined
          ? (Array.isArray(body.suggestedAmbient) ? body.suggestedAmbient[0] : body.suggestedAmbient)
          : existing.suggestedAmbient,
        motionHints: body.motionHints !== undefined
          ? (Array.isArray(body.motionHints)
            ? body.motionHints
            : typeof body.motionHints === 'string'
              ? body.motionHints.split('\n').map((h) => h.trim()).filter(Boolean)
              : [])
          : existing.motionHints,
        music: body.music !== undefined ? body.music : existing.music,
      };
    }

    const { problems } = validateStyle(updated, { expectedName: targetName, ambients });
    if (problems.length > 0) {
      throw new ApiError(422, 'Style validation failed', { problems });
    }

    const targetStylePath = join(stylesDir, `${targetName}.json`);
    await writeTextFile(targetStylePath, JSON.stringify(updated, null, 2) + '\n');
    if (targetName !== name) {
      await unlink(stylePath).catch(() => {});
    }

    return { style: await describeLibraryStyle(targetName, { stylesDir, ambients }) };
  });
}

/**
 * Kutuphaneden stil siler.
 */
export async function deleteLibraryStyle(name, { stylesDir = STYLES_DIR } = {}) {
  if (name === CUSTOM_STYLE_NAME) {
    throw new ApiError(400, `Style "${CUSTOM_STYLE_NAME}" is reserved and cannot be deleted`);
  }
  if (!STYLE_NAME_PATTERN.test(name)) {
    throw new ApiError(400, 'Invalid style name');
  }

  return exclusive(`style:${name}`, async () => {
    const stylePath = join(stylesDir, `${name}.json`);
    const exists = (await listStyles({ dir: stylesDir })).includes(name);
    if (!exists) {
      throw new ApiError(404, `Style "${name}" not found`);
    }

    await rm(stylePath, { force: true });

    // Referans gorselleri varsa sil
    const refs = await findStyleRefs(name, { dir: stylesDir });
    for (const p of refs.paths) {
      await rm(p, { force: true });
    }

    return { ok: true, deleted: name };
  });
}

/**
 * Projeye ozel stil (custom-generated) uretimi — panelin style-references
 * adimiyla ayni generateProjectStyle. Kaynak: projenin references/ gorselleri.
 *
 * @param {unknown} body bos ya da `{ overwrite? }` (STYLE_BLOCK.txt varken gerekli)
 * @param {{ gemini?: object }} [options] gemini: describeMultiReferenceStyle ortam/test secenekleri
 * @returns {Promise<{ project: object, warnings: string[] }>}
 */
export async function generateStyle(id, body, {
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  gemini = {},
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { overwrite = false } = parseBody(body ?? {}, { overwrite: 'boolean' });

  return exclusive(`project:${projectDir.toLowerCase()}`, async () => {
    const status = await inspectProject(projectDir);
    if (!status.projectJson.ok) {
      throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
    }
    if (status.style !== CUSTOM_STYLE_NAME) {
      throw new ApiError(409, `Project style is not ${CUSTOM_STYLE_NAME}`, { style: status.style });
    }
    if (status.styleBlockExists && !overwrite) {
      throw new ApiError(409, 'Project style already generated');
    }
    const references = [];
    for (const path of status.references) {
      if (await realPathInside(projectDir, path)) references.push(path);
    }
    if (references.length === 0) {
      throw new ApiError(409, 'No reference images in the project references folder', {
        referencesDir: join(projectDir, 'references'),
      });
    }

    const describeOptions = geminiOptions(gemini);
    let result;
    try {
      result = await generateProjectStyle({ ...status, references }, { ambientDir, describeOptions });
    } catch (error) {
      if (error instanceof ProjectStyleError) {
        throw new ApiError(422, 'Style could not be generated', { problem: error.message });
      }
      throw generationApiError(error instanceof StyleGenerationError ? error.cause : error);
    }
    return { project: await getProject(id, { videosDir }), warnings: result.warnings };
  });
}

/**
 * Master frame (Faz 1) — elle adim: gorsel disarida uretilir ve
 * resimler/MASTER.<uzanti> olarak konur. Panelin FAZ 1 ekranindaki prompt
 * (projectPromptStyle + getPhasePrompts) ve algilama (inspectProject) ayni.
 *
 * @param {{ videosDir?: string, stylesDir?: string }} [options]
 */
export async function getMaster(id, { videosDir = DEFAULT_VIDEOS_DIR, stylesDir = STYLES_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);

  const masterPath = status.master && await realPathInside(projectDir, status.master);
  const file = masterPath ? basename(status.master) : null;
  const previewable = file !== null && assetContentType('master', file) !== null;

  let prompt = null;
  let promptError = null;
  try {
    const style = await projectPromptStyle(status, { stylesDir });
    prompt = (await getPhasePrompts({ videoName: status.name, style })).faz1 || null;
    if (prompt === null) promptError = 'faz1-master.txt şablonu bulunamadı';
  } catch (error) {
    promptError = error.message;
  }

  return {
    ready: file !== null,
    file,
    previewUrl: previewable ? assetUrl(id, 'master', file) : null,
    folder: join(projectDir, 'resimler'),
    expectedName: 'MASTER.png',
    acceptedExtensions: Object.keys(ASSET_MIME_TYPES).filter((ext) => ASSET_MIME_TYPES[ext].startsWith(ASSET_TYPES.master.kind)),
    prompt,
    promptError,
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
  const { watermark, cropBottom, cropTop, cropLeft, cropRight } = parseBody(body, {
    watermark: 'boolean',
    cropBottom: 'number',
    cropTop: 'number',
    cropLeft: 'number',
    cropRight: 'number',
  });
  if (watermark === undefined && cropBottom === undefined && cropTop === undefined && cropLeft === undefined && cropRight === undefined) {
    throw new ApiError(400, 'Missing field: watermark or cropBottom');
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
 * Montaji arka planda baslatir. Panel gibi build.js'i ayri surecte calistirir;
 * hazir olmayan projeyi (nextStep build/done degil) baslatmaz.
 *
 * @param {unknown} body `{ overwrite? }`
 * @param {{ videosDir?: string, buildJobs: ReturnType<typeof import('./build-jobs.js').createBuildJobs> }} options
 */
export async function startBuild(id, body, { videosDir = DEFAULT_VIDEOS_DIR, buildJobs }) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { overwrite = false } = parseBody(body ?? {}, { overwrite: 'boolean' });

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

  return buildJobs.start(id, { projectPath: status.projectPath, overwrite });
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
  const cropReady = isCropBottom(cropBottom);

  const missing = [];
  if (!status.projectJson.ok) missing.push('projectJson');
  if (!clipReady) missing.push('clip');
  if (!musicReady) missing.push('music');
  if (status.projectJson.ok && !cropReady) missing.push('cropBottom');

  return {
    style: {
      ready: !(status.style === CUSTOM_STYLE_NAME && !status.styleBlockExists),
      name: status.style === '-' ? null : status.style,
      styleBlockExists: status.styleBlockExists,
      referenceCount: status.references.length,
    },
    master: { ready: status.master !== null },
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
      cropBottom: cropReady ? cropBottom : null,
      watermark: cropReady ? cropBottom > 0 : null,
      defaultCropBottom: DEFAULT_CROP_BOTTOM,
    },
    build: { ready: missing.length === 0, missing },
    output: { exists: status.output.exists },
  };
}

// ---------------------------------------------------------------- yardimcilar

/** Kimligi dogrular; videolar kokunun dogrudan alti ve project.json'lu olmali. */
async function resolveProjectDir(id, videosDir) {
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
  return contentType?.startsWith(ASSET_TYPES[assetType].kind) ? contentType : null;
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

/** Kutuphane stil girdisi (GET /api/library ve POST /api/styles ayni bicim). */
async function describeLibraryStyle(name, { stylesDir, ambients }) {
  try {
    const { style, warnings } = await loadStyle(name, { dir: stylesDir, ambients });
    const { paths } = await findStyleRefs(name, { dir: stylesDir });
    const references = paths.map((p, idx) => {
      const filename = basename(p);
      return {
        name: filename,
        url: `/api/styles/${encodeURIComponent(name)}/images/${encodeURIComponent(filename)}?t=${Date.now()}`,
      };
    });
    return {
      name,
      kind: 'library',
      valid: true,
      suggestedAmbient: style.suggestedAmbient,
      hasReference: paths.length > 0,
      refUrl: paths.length > 0 ? `/api/styles/${encodeURIComponent(name)}/images/${encodeURIComponent(basename(paths[0]))}?t=${Date.now()}` : null,
      refUrls: references.map((r) => r.url),
      references,
      styleBlock: style.styleBlock,
      motionHints: style.motionHints,
      music: style.music,
      warnings: [...warnings],
    };
  } catch (error) {
    if (!(error instanceof StyleError)) throw error;
    return { name, kind: 'library', valid: false, problems: error.problems };
  }
}

/**
 * Stilin referans görselini sunar.
 */
export async function getStyleAsset(name, options = {}) {
  const { stylesDir = STYLES_DIR, file, idx } = typeof options === 'string' ? { file: options } : options;
  const { paths } = await findStyleRefs(name, { dir: stylesDir });
  if (paths.length === 0) throw new ApiError(404, 'Style reference image not found');

  let targetPath = paths[0];
  if (file) {
    const found = paths.find((p) => basename(p) === file);
    if (found) targetPath = found;
  } else if (idx !== undefined && !Number.isNaN(Number(idx))) {
    const num = Number(idx);
    if (paths[num]) targetPath = paths[num];
  }

  const info = await stat(targetPath);
  const ext = extname(targetPath).toLowerCase();
  const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { path: targetPath, size: info.size, contentType };
}

async function ambientsOrEmpty(ambientDir) {
  try {
    return await listAmbients(ambientDir);
  } catch (error) {
    if (error instanceof AmbientError) return [];
    throw error;
  }
}

/** Ayni anahtarla suren is varken 409; anahtar is bitince (hata dahil) birakilir. */
async function exclusive(key, fn) {
  if (runningGenerations.has(key)) throw new ApiError(409, 'Generation already in progress');
  runningGenerations.add(key);
  try {
    return await fn();
  } finally {
    runningGenerations.delete(key);
  }
}

/**
 * Gemini seceneklerini hazirlar; anahtar yoksa istek hic gitmeden 503.
 * .env sunucunun calisma klasorunden bagimsiz olarak repo kokunden yuklenir.
 */
function geminiOptions({ env = process.env, repoRoot = REPO_ROOT, loadEnvFn = loadEnv, ...rest } = {}) {
  loadEnvFn(repoRoot);
  if (!getApiKey(env)) throw new ApiError(503, 'GEMINI_API_KEY is not configured');
  return { env, repoRoot, loadEnvFn, ...rest };
}

/**
 * Gemini istek/yanit/dogrulama hatasi → 502. Duz Error: describe-style'in
 * "gecersiz stil"/"bos cevap" hatalari. Diger turler (programlama hatasi) 500'e kalir.
 */
function generationApiError(error) {
  if (error instanceof GeminiError) {
    return new ApiError(502, 'Style generation failed', {
      problem: error.message,
      upstreamStatus: error.status ?? null,
      quotaExceeded: error.quotaExceeded,
    });
  }
  if (error?.constructor === Error) {
    return new ApiError(502, 'Style generation failed', { problem: error.message });
  }
  return error;
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
    { name: 'string', style: 'string', ambient: 'array', concept: 'string', totalTracks: 'number' },
    ['name', 'style'],
  );

  const ambient = input.ambient ?? [];
  if (!ambient.every((name) => typeof name === 'string' && name.trim() !== '')) {
    throw new ApiError(400, 'ambient must be an array of names');
  }
  if (input.concept !== undefined && input.concept.length > MAX_CONCEPT_LENGTH) {
    throw new ApiError(400, `concept must be at most ${MAX_CONCEPT_LENGTH} characters`);
  }
  if (input.totalTracks !== undefined
    && (!Number.isInteger(input.totalTracks) || input.totalTracks < 1 || input.totalTracks > MAX_TRACKS)) {
    throw new ApiError(400, `totalTracks must be an integer between 1 and ${MAX_TRACKS}`);
  }

  const concept = input.concept?.trim();
  return {
    name: input.name,
    style: input.style,
    ambient,
    concept: concept || undefined,
    totalTracks: input.totalTracks,
  };
}

/**
 * Duz JSON nesnesi; bilinmeyen anahtar ve yanlis tip 400.
 *
 * @param {unknown} body
 * @param {Record<string, 'string'|'number'|'boolean'|'array'>} schema
 * @param {string[]} [required]
 */
function parseBody(body, schema, required = []) {
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

export async function addProjectReference(id, body, {
  videosDir = DEFAULT_VIDEOS_DIR,
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { name, data } = uploadName(body, SUPPORTED_IMAGE_EXTENSIONS, 'reference');
  const buffer = decodeUpload(data, MAX_IMAGE_SIZE_BYTES, 'Reference image');

  const refDir = join(projectDir, 'references');
  await mkdir(refDir, { recursive: true });
  const targetPath = join(refDir, name);
  await writeFile(targetPath, buffer);

  return getProject(id, { videosDir });
}

export async function deleteProjectReference(id, name, {
  videosDir = DEFAULT_VIDEOS_DIR,
} = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  if (!isPlainName(name)) throw new ApiError(400, 'Invalid reference file name');

  const targetPath = join(projectDir, 'references', name);
  await unlink(targetPath).catch(() => null);

  return getProject(id, { videosDir });
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

const MAX_ANGLES = 5;
const MAX_CLIP_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Adım 3/4/5 görsel yüklemesi → resimler/. Dosya adı yuvaya göre sabittir
 * (inspectProject bu adlarla bulur): scene-ref.*, MASTER.*, Master<N>.*.
 * Aynı yuvadaki başka uzantılı eski dosya kaldırılır — iki MASTER olmasın.
 *
 * @param {unknown} body `{ slot: 'scene'|'master'|'angle', index?, name, data }`
 */
export async function uploadProjectImage(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { data, ext } = uploadName(body, SUPPORTED_IMAGE_EXTENSIONS, 'image', { slot: 'string', index: 'number' });
  const { slot, index } = body;

  let base;
  let sameSlot;
  if (slot === 'scene') {
    base = 'scene-ref';
    sameSlot = (file) => SCENE_REF_PATTERN.test(file);
  } else if (slot === 'master') {
    base = 'MASTER';
    sameSlot = (file) => MASTER_PATTERN.test(file);
  } else if (slot === 'angle') {
    if (!Number.isInteger(index) || index < 1 || index > MAX_ANGLES) {
      throw new ApiError(400, `index must be an integer between 1 and ${MAX_ANGLES}`);
    }
    base = `Master${index}`;
    sameSlot = (file) => ANGLE_PATTERN.exec(file)?.[1] === String(index);
  } else {
    throw new ApiError(400, 'slot must be scene, master or angle');
  }
  const buffer = decodeUpload(data, MAX_IMAGE_SIZE_BYTES, 'Image');

  const imagesDir = join(projectDir, 'resimler');
  await mkdir(imagesDir, { recursive: true });
  const target = `${base}${ext}`;
  for (const existing of await readdir(imagesDir)) {
    if (existing !== target && sameSlot(existing)) await unlink(join(imagesDir, existing));
  }
  await writeFile(join(imagesDir, target), buffer);
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
  return getProject(id, { videosDir });
}

/**
 * Adım 5 kararı → project.json `workflow.angles`. Build bu alanı okumaz.
 *
 * @param {unknown} body `{ angles: { wanted: boolean, count?: number } }`
 */
export async function updateWorkflow(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { angles } = parseBody(body ?? {}, { angles: 'object' }, ['angles']);
  if (angles === null || Array.isArray(angles) || typeof angles.wanted !== 'boolean') {
    throw new ApiError(400, 'angles.wanted must be a boolean');
  }
  let next = { wanted: false };
  if (angles.wanted) {
    if (!Number.isInteger(angles.count) || angles.count < 1 || angles.count > MAX_ANGLES) {
      throw new ApiError(400, `angles.count must be an integer between 1 and ${MAX_ANGLES}`);
    }
    next = { wanted: true, count: angles.count };
  }

  const status = await inspectProject(projectDir);
  if (!status.projectJson.ok) {
    throw new ApiError(409, 'project.json is invalid', { problem: status.projectJson.error });
  }
  await setProjectField(status.projectPath, 'workflow', { ...workflowOf(status), angles: next });
  return getProject(id, { videosDir });
}

/**
 * Adım 8 → project.json `order` (build.js'in okuduğu alan) ve
 * `workflow.order` (seçilen yöntem). Alfabetik: audioDir'in doğal sırası
 * (build'in sırasız düşüşüyle aynı listFiles sırası).
 *
 * @param {unknown} body `{ mode: 'alphabetical'|'manual', order?: string[] }`
 */
export async function updateTrackOrder(id, body, { videosDir = DEFAULT_VIDEOS_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const { mode, order } = parseBody(body ?? {}, { mode: 'string', order: 'object' }, ['mode']);
  if (mode !== 'alphabetical' && mode !== 'manual') {
    throw new ApiError(400, 'mode must be alphabetical or manual');
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
  if (mode === 'manual') {
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

/**
 * Kopyalanacak promptlar — yalnızca kod blokları (başlık/not metni değil):
 * Faz 1 master, Faz 2 açı listesi (başlık + metin), Faz 3 hareket.
 */
export async function getProjectPrompts(id, { videosDir = DEFAULT_VIDEOS_DIR, stylesDir = STYLES_DIR } = {}) {
  const projectDir = await resolveProjectDir(id, videosDir);
  const status = await inspectProject(projectDir);
  const style = await projectPromptStyle(status, { stylesDir });
  const phases = await getPhasePrompts({ videoName: status.name, style });

  const firstBlock = (md) => codeBlocks(md).blocks[0]?.trim() || null;
  const angles = phases.faz2
    .split(/^### /m)
    .slice(1)
    .map((section) => ({
      title: section.split('\n')[0].replace(/^\d+\s*[—-]\s*/, '').trim(),
      prompt: firstBlock(section),
    }))
    .filter((angle) => angle.prompt);

  return {
    master: firstBlock(phases.faz1),
    angles,
    video: firstBlock(phases.faz3),
  };
}
