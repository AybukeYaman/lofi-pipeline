/**
 * Proje stili: faz promptlarında kullanılacak stil (projectPromptStyle) ve
 * projeye özel stil (custom-generated) — references/ görsellerinden Gemini ile
 * sentez ve kalıcı yazım. Panel ve web aynı fonksiyonları kullanır.
 *
 * Yazım sırası: önce project.json alanları, en son STYLE_BLOCK.txt — proje
 * durumu (project-status.js) adımı STYLE_BLOCK.txt varlığına göre geçer.
 */

import { stat } from 'node:fs/promises';

import { writeTextFile } from '../core/workspace.js';
import { MAX_IMAGE_SIZE_BYTES, describeMultiReferenceStyle } from './describe-style.js';
import { setProjectField } from './project-file.js';
import { CUSTOM_STYLE_NAME, STYLES_DIR, loadStyle, renderStyleBlock } from './styles.js';

export class ProjectStyleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ProjectStyleError';
  }
}

/** Gemini tarafında (istek/yanıt/doğrulama) başarısız olan üretim; `cause` asıl hata. */
export class StyleGenerationError extends Error {
  /**
   * @param {string} message
   * @param {{ cause: unknown }} options
   */
  constructor(message, { cause }) {
    super(message, { cause });
    this.name = 'StyleGenerationError';
  }
}

/**
 * Faz promptlarında kullanılacak stil: projede üretilmiş `styleBlock` varsa o,
 * yoksa kütüphanedeki stil. Bulunamazsa null (getPhasePrompts varsayılanı).
 *
 * @param {{ style: string, projectJson: { data: object|null } }} status inspectProject çıktısı
 * @param {{ stylesDir?: string }} [options]
 * @returns {Promise<object|null>}
 */
export async function projectPromptStyle(status, { stylesDir = STYLES_DIR } = {}) {
  const data = status.projectJson.data;
  const name = status.style !== '-' ? status.style : (data?.style ?? 'cozy-realistic');
  if (data?.styleBlock) {
    return { name, styleBlock: data.styleBlock, motionHints: data.motionHints || ['subtle motion'] };
  }
  const loaded = await loadStyle(name, { dir: stylesDir }).catch(() => null);
  return loaded?.style ?? null;
}

/**
 * @param {{
 *   name: string, projectPath: string, styleBlockPath: string,
 *   references: string[], projectJson: { data: object|null },
 * }} status inspectProject çıktısı (references çağıran tarafından süzülebilir)
 * @param {{
 *   ambientDir?: string,
 *   describeOptions?: object,
 *   describeFn?: typeof describeMultiReferenceStyle,
 * }} [options] describeOptions: describeMultiReferenceStyle seçenekleri (generateContentFn, env, repoRoot…)
 * @returns {Promise<{ style: object, warnings: string[] }>}
 */
export async function generateProjectStyle(status, {
  ambientDir,
  describeOptions = {},
  describeFn = describeMultiReferenceStyle,
} = {}) {
  if (status.references.length === 0) {
    throw new ProjectStyleError('references/ klasörüne en az 1 görsel ekleyin');
  }
  for (const path of status.references) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new ProjectStyleError(`referans görsel okunamıyor: ${path}`);
    if (info.size > MAX_IMAGE_SIZE_BYTES) {
      throw new ProjectStyleError(`referans görsel 15 MB'tan büyük: ${path}`);
    }
  }

  const concept = status.projectJson.data?.concept || `${status.name} Album Concept`;
  let result;
  try {
    result = await describeFn({
      imagePaths: status.references,
      concept,
      name: CUSTOM_STYLE_NAME,
      options: { ambientDir, ...describeOptions },
    });
  } catch (cause) {
    throw new StyleGenerationError(cause.message, { cause });
  }

  const { style } = result;
  await setProjectField(status.projectPath, 'styleBlock', style.styleBlock);
  await setProjectField(status.projectPath, 'motionHints', style.motionHints);
  await setProjectField(status.projectPath, 'style', CUSTOM_STYLE_NAME);
  await writeTextFile(status.styleBlockPath, renderStyleBlock(style) + '\n', { bom: true });
  return result;
}
