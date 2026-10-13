/**
 * Aşama 4a — Etiket katmanı hazırlığı.
 *
 * `project.json` → `labels` planını montajın (04) ffmpeg filtresine çevirir:
 * font dosyasını doğrular, metin dosyalarını çalışma klasörüne yazar,
 * `core/label-filter.js`'ten drawtext zincirini alır. Videoyu KENDİSİ
 * işlemez — filtre dizesini montaja verir; etiket yoksa `filter: null` döner
 * ve montaj eski (gövde kopya, yalnızca kuyruk encode) yolundan aynen sürer.
 *
 * Pomodoro oturumları buraya DIŞARIDAN gelir (`audio.pomodoro.timeline`);
 * zamanlama/durum kararı bu adımda verilmez.
 */

import { access } from 'node:fs/promises';

import { buildLabelFilter } from '../core/label-filter.js';
import { probe } from '../core/probe.js';

/** Windows'ta her makinede bulunan, Türkçe karakterleri kapsayan font. */
export const DEFAULT_LABEL_FONT_FILE = 'C:/Windows/Fonts/arial.ttf';

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * @param {object} options
 * @param {object[]} options.labels core/label-plan.js `labels`
 * @param {string} [options.videoPath] yüksekliği buradan okunur (base.mp4); `height` verilirse gerekmez
 * @param {number} [options.height] çıktı kare yüksekliği (px) — Shorts için sabit 1920
 * @param {Array<{ name: string, startSeconds: number, endSeconds: number }>|null} [options.sessions]
 *   Pomodoro timeline oturumları; Pomodoro kapalıysa null
 * @param {object} options.workspace core/workspace.js örneği
 * @param {string} [options.fontFile]
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @returns {Promise<{ filter: string|null, labelCount: number, skipped: string[] }>}
 */
export async function prepareLabelOverlay({
  labels,
  videoPath,
  height: givenHeight = null,
  sessions = null,
  workspace,
  fontFile = DEFAULT_LABEL_FONT_FILE,
  logger = NOOP_LOGGER,
}) {
  if (!labels || labels.length === 0) return { filter: null, labelCount: 0, skipped: [] };

  const height = givenHeight ?? (await probe(videoPath)).height;
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`Etiketler için video yüksekliği okunamadı: ${videoPath}`);
  }

  const built = buildLabelFilter({
    labels,
    height,
    fontFile,
    sessions,
    textPath: (name) => workspace.path(name),
  });
  for (const message of built.skipped) logger.warn(message);
  if (built.filter === null) return { filter: null, labelCount: 0, skipped: built.skipped };

  try {
    await access(fontFile);
  } catch {
    throw new Error(
      `Etiket yazı tipi bulunamadı: ${fontFile}. Etiketleri yakmak için bu dosya gerekli.`,
    );
  }
  for (const file of built.files) await workspace.writeText(file.name, file.content);

  const labelCount = labels.length - built.skipped.length;
  logger.info(`Etiket katmanı hazır: ${labelCount} etiket (${height} px yükseklik).`);
  return { filter: built.filter, labelCount, skipped: built.skipped };
}
