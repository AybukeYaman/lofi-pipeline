/**
 * Video proje klasörü — plan (saf) ve yazım.
 *
 * Tek sorumluluk: videolar/<isim>/ altındaki iskeleti kurmak. Stil ve ambient
 * seçimini doğrulamaz (çağıran loadStyle / findAmbient ile verir), medya
 * üretmez. Var olan klasöre asla yazmaz.
 */

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { writeTextFile } from '../core/workspace.js';
import { DEFAULT_CROP_BOTTOM } from './project-file.js';
import { generateMusicPlan, generateMusicPlanAsync } from './music-planner.js';
import { buildPromptsMd } from './prompts.js';
import { CUSTOM_STYLE_NAME, renderStyleBlock } from './styles.js';

/** Albüm klasörlerinin kökü. `--videos-dir` ezer. */
export const DEFAULT_VIDEOS_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\videolar';

/** Kullanıcının mevcut düzeni (HANDOFF bölüm 9). */
export const PROJECT_SUBDIRS = ['audio', 'resimler', 'videolar', 'references'];

export class ProjectExistsError extends Error {
  /** @param {string} dir */
  constructor(dir) {
    super(`klasör zaten var, dokunulmadı: ${dir}`);
    this.name = 'ProjectExistsError';
    this.dir = dir;
  }
}

/**
 * Windows klasör adı kuralları. Boşluk ve `&` serbest (bölüm 9).
 *
 * @param {unknown} name
 * @returns {string[]} problemler
 */
export function validateVideoName(name) {
  if (typeof name !== 'string' || name.trim() === '') return ['isim boş olamaz'];

  const problems = [];
  const invalid = [...new Set(name.match(/[<>:"/\\|?*\x00-\x1f]/g) ?? [])];
  if (invalid.length > 0) {
    problems.push(`isim Windows'ta geçersiz karakter içeriyor: ${invalid.map((c) => JSON.stringify(c)).join(' ')}`);
  }
  if (/[. ]$/.test(name)) problems.push('isim nokta ya da boşlukla bitemez (Windows sessizce kırpıyor)');
  if (/^\s/.test(name)) problems.push('isim boşlukla başlayamaz');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) problems.push(`"${name}" Windows'ta ayrılmış bir ad`);
  return problems;
}

/**
 * Oluşturulacak klasör, dosya ve kopyalar — diske dokunmaz.
 *
 * @param {{
 *   videosDir: string,
 *   videoName: string,
 *   style: object,
 *   ambient: { name: string, path: string } | null,
 *   styleRef: string | null,
 *   templates: { file: string, text: string }[],
 *   concept?: string,
 *   totalTracks?: number,
 *   musicPlan?: object,
 * }} input style doğrulanmış (loadStyle), isim doğrulanmış (validateVideoName)
 * @returns {{
 *   dir: string,
 *   subdirs: string[],
 *   files: { name: string, path: string, content: string, bom: boolean }[],
 *   copies: { from: string, path: string }[],
 * }}
 */
export function planProject({ videosDir, videoName, style, ambient, styleRef, templates, concept, totalTracks, musicPlan }) {
  const dir = join(videosDir, videoName);

  const ambientVal = Array.isArray(ambient)
    ? ambient.map((a) => a.path)
    : (ambient ? ambient.path : null);

  const plan = musicPlan || generateMusicPlan({
    concept: concept || `${videoName} Album Concept`,
    style: style.name,
    totalTracks: totalTracks || 17,
  });

  const project = {
    clip: '',
    audioDir: './audio',
    ...(ambientVal ? { ambient: ambientVal } : {}),
    video: { cropBottom: DEFAULT_CROP_BOTTOM, aspect: '16:9' },
    output: { dir: './out' },
    music: plan,
    style: style.name,
    ...(style.name === CUSTOM_STYLE_NAME && style.styleBlock ? { styleBlock: style.styleBlock, motionHints: style.motionHints } : {}),
  };

  const files = [
    ...(style.name === CUSTOM_STYLE_NAME && !style.styleBlock ? [] : [{ name: 'STYLE_BLOCK.txt', content: renderStyleBlock(style) + '\n', bom: true }]),
    { name: 'project.json', content: JSON.stringify(project, null, 2) + '\n', bom: false },
    { name: 'prompts.md', content: buildPromptsMd({ videoName, style, templates }), bom: true },
  ];

  return {
    dir,
    subdirs: PROJECT_SUBDIRS.map((name) => join(dir, name)),
    files: files.map((file) => ({ ...file, path: join(dir, file.name) })),
    copies: styleRef
      ? [{ from: styleRef, path: join(dir, 'resimler', `style-ref${extname(styleRef).toLowerCase()}`) }]
      : [],
  };
}

export async function planProjectAsync(options) {
  const musicPlan = await generateMusicPlanAsync({
    concept: options.concept || `${options.videoName} Album Concept`,
    style: options.style.name,
    totalTracks: options.totalTracks || 17,
  });
  return planProject({ ...options, musicPlan });
}

/**
 * Planı diske yazar. Klasör `mkdir` ile tek adımda ve özyinelemesiz açılır:
 * varsa EEXIST — "var mı" sorusu ile oluşturma arasında yarış yok.
 * Yarıda hata olursa bu çağrının açtığı klasör geri silinir.
 *
 * @param {ReturnType<typeof planProject>} plan
 * @param {{
 *   writeText?: (path: string, content: string, options: { bom: boolean }) => Promise<unknown>,
 *   copy?: (from: string, to: string) => Promise<unknown>,
 * }} [options] testte yazım/kopya hatası taklidi için
 * @returns {Promise<string>} proje klasörü
 */
export async function writeProject(plan, { writeText = writeTextFile, copy = copyFile } = {}) {
  try {
    await mkdir(plan.dir);
  } catch (cause) {
    if (cause.code === 'EEXIST') throw new ProjectExistsError(plan.dir);
    if (cause.code === 'ENOENT') {
      throw new Error(`üst klasör bulunamadı (videolar kökü doğru mu?): ${plan.dir}`, { cause });
    }
    throw cause;
  }

  try {
    for (const subdir of plan.subdirs) await mkdir(subdir);
    for (const { from, path } of plan.copies) await copy(from, path);
    for (const file of plan.files) await writeText(file.path, file.content, { bom: file.bom });
  } catch (error) {
    await rm(plan.dir, { recursive: true, force: true });
    throw error;
  }
  return plan.dir;
}
