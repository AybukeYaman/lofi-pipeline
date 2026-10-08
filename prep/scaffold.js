/**
 * Video proje klasörü — plan (saf) ve yazım.
 *
 * Tek sorumluluk: videolar/<isim>/ altındaki iskeleti kurmak. Stil ve ambient
 * seçimini doğrulamaz (çağıran findAmbient ile verir), medya
 * üretmez. Var olan klasöre asla yazmaz.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { VIDEO_SOURCES } from '../core/config.js';
import { writeTextFile } from '../core/workspace.js';
import { DEFAULT_CROP_BOTTOM } from './project-file.js';
import { generateMusicPlanAsync } from './music-planner.js';

/** Albüm klasörlerinin kökü. `--videos-dir` ezer. */
export const DEFAULT_VIDEOS_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\videolar';

/** Kullanıcının mevcut düzeni (HANDOFF bölüm 9). */
export const PROJECT_SUBDIRS = ['audio', 'resimler', 'videolar'];

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
 * Kural core/project-name.js'te: web formu da aynı kuralı kullanıyor, iki
 * yerde ayrı yazılınca sapıyordu. Buradan yeniden ihraç ediliyor, mevcut
 * çağıranlar (server/, ui/, test/) değişmedi.
 */
export { validateVideoName } from '../core/project-name.js';

/**
 * Oluşturulacak klasör, dosya ve kopyalar — diske dokunmaz.
 *
 * @param {{
 *   videosDir: string,
 *   videoName: string,
 *   ambient: { name: string, path: string } | null,
 *   concept?: string,
 *   totalTracks?: number,
 *   musicPlan?: object,
 *   videoSource?: 'clip'|'image',
 * }} input videoSource: 'image' → tüm video boyunca tek resim (watermark yok, kırpma 0);
 *   isim doğrulanmış (validateVideoName)
 * @returns {{
 *   dir: string,
 *   subdirs: string[],
 *   files: { name: string, path: string, content: string, bom: boolean }[],
 * }}
 */
export function planProject({ videosDir, videoName, ambient, concept, totalTracks, musicPlan, videoSource = 'clip', parentId = null, aspect = '16:9' }) {
  if (!VIDEO_SOURCES.includes(videoSource)) {
    throw new Error(`videoSource: ${VIDEO_SOURCES.join(' | ')} olmalı (verilen: ${JSON.stringify(videoSource)})`);
  }
  const dir = join(videosDir, videoName);

  const ambientVal = Array.isArray(ambient)
    ? ambient.map((a) => a.path)
    : (ambient ? ambient.path : null);

  const validAspect = aspect === '9:16' ? '9:16' : '16:9';

  const project = {
    clip: '',
    audioDir: './audio',
    ...(parentId ? { parentId } : {}),
    ...(ambientVal ? { ambient: ambientVal } : {}),
    // Tek resim AI görseli: kırpılacak watermark yok. Klip modu varsayılan olduğu için alan yazılmaz.
    video: videoSource === 'image'
      ? { source: 'image', cropBottom: 0, aspect: validAspect }
      : { cropBottom: DEFAULT_CROP_BOTTOM, aspect: validAspect },
    output: { dir: './out' },
    // Müzik planı ARTIK VARSAYILAN DEĞİL: proje açılırken uydurma başlıklı
    // (CONCEPT_DICTIONARIES) sabit bir parça listesi yazılıyordu, kullanıcı
    // kendi koymadığı 17 şarkıyı listede görüyordu. Plan yalnızca açıkça
    // istenirse (`totalTracks` / `--total-tracks`) üretilir; müzik adımı
    // bunun dışında audio/ klasöründeki GERÇEK dosyaları gösterir.
    ...(musicPlan ? { music: musicPlan } : {}),
  };

  const files = [
    { name: 'project.json', content: JSON.stringify(project, null, 2) + '\n', bom: false },
  ];

  return {
    dir,
    subdirs: PROJECT_SUBDIRS.map((name) => join(dir, name)),
    files: files.map((file) => ({ ...file, path: join(dir, file.name) })),
  };
}

/**
 * `totalTracks` verilmişse Suno için parça planı üretir; verilmemişse plan
 * yazılmaz (bkz. planProject'teki not).
 */
export async function planProjectAsync(options) {
  if (options.totalTracks === undefined || options.totalTracks === null) {
    return planProject(options);
  }
  const musicPlan = await generateMusicPlanAsync(musicPlanInput(options));
  return planProject({ ...options, musicPlan });
}

/** Müzik planlayıcısının girdisi; yalnızca plan açıkça istendiğinde çağrılır. */
function musicPlanInput({ videoName, concept, totalTracks }) {
  return {
    concept: concept || `${videoName} Album Concept`,
    totalTracks,
  };
}

/**
 * Planı diske yazar. Klasör `mkdir` ile tek adımda ve özyinelemesiz açılır:
 * varsa EEXIST — "var mı" sorusu ile oluşturma arasında yarış yok.
 * Yarıda hata olursa bu çağrının açtığı klasör geri silinir.
 *
 * @param {ReturnType<typeof planProject>} plan
 * @param {{
 *   writeText?: (path: string, content: string, options: { bom: boolean }) => Promise<unknown>,
 * }} [options] testte yazım hatası taklidi için
 * @returns {Promise<string>} proje klasörü
 */
export async function writeProject(plan, { writeText = writeTextFile } = {}) {
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
    for (const file of plan.files) await writeText(file.path, file.content, { bom: file.bom });
  } catch (error) {
    await rm(plan.dir, { recursive: true, force: true });
    throw error;
  }
  return plan.dir;
}
