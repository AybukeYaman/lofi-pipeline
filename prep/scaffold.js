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
import { buildPromptsMd } from './prompts.js';
import { renderStyleBlock } from './styles.js';

/** Albüm klasörlerinin kökü. `--videos-dir` ezer. */
export const DEFAULT_VIDEOS_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\videolar';

/** Kullanıcının mevcut düzeni (HANDOFF bölüm 9). */
export const PROJECT_SUBDIRS = ['audio', 'resimler', 'videolar'];

/** Watermark kırpması — Hailuo'da ölçülen değer (bölüm 4). */
const CROP_BOTTOM = 150;

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
 * }} input style doğrulanmış (loadStyle), isim doğrulanmış (validateVideoName)
 * @returns {{
 *   dir: string,
 *   subdirs: string[],
 *   files: { name: string, path: string, content: string, bom: boolean }[],
 *   copies: { from: string, path: string }[],
 * }}
 */
export function planProject({ videosDir, videoName, style, ambient, styleRef, templates }) {
  const dir = join(videosDir, videoName);

  // Anahtar sırası okunuş sırası. `clip` bilerek boş: klip Faz 3'ten sonra
  // gelir; build o zamana kadar "clip: boş olmayan bir metin olmalı" der.
  const project = {
    clip: '',
    audioDir: './audio',
    ...(ambient ? { ambient: ambient.path } : {}),
    video: { cropBottom: CROP_BOTTOM, aspect: '16:9' },
    output: { dir: './out' },
  };

  // bom: insanın okuduğu metinler BOM'lu — PowerShell 5.1 Get-Content BOM'suz
  // UTF-8'i cp1254 sanıyor. project.json BOM'suz: JSON'da BOM standart dışı
  // (readJsonFile iki biçimi de okur).
  const files = [
    { name: 'STYLE_BLOCK.txt', content: renderStyleBlock(style) + '\n', bom: true },
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
