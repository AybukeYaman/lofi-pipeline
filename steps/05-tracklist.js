/**
 * Aşama 5a — Tracklist.
 *
 * Aşama 2 manifest'indeki parçalardan (dosya, başlangıç, süre) YouTube
 * açıklamasına yapıştırılacak zaman damgalı listeyi üretir:
 *
 *   0:00  Midnight Window
 *   3:19  Midnight Street
 *
 * Dosyaları yeniden ölçmez — süreler manifest'ten gelir. Görünen ad üretimi
 * de burada: ad bir tracklist kaygısı, ses birleştirmenin değil.
 */

import { mkdir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { normalizeName } from '../core/files.js';
import { writeTextFile } from '../core/workspace.js';

/**
 * YouTube'un açıklamadaki damgaları bölüm (chapter) olarak tanıma şartları.
 * Uymayan liste yine yazılır — açıklama metni olarak işe yarar — ama uyarılır.
 */
export const CHAPTER_RULES = { minChapters: 3, minChapterSeconds: 10 };

/** Damga ile ad arasındaki ayraç (mevcut tracklist.txt ile aynı). */
const SEPARATOR = '  ';

/**
 * Başlıkta küçük kalan kelimeler. Yalnızca ilk kelimeden sonra geçerli:
 * "on the glass" küçük, ama "The Quiet Room" başta olduğu için büyük.
 * Böylece her albümde names eşlemesine elle yazmak gerekmiyor.
 */
const SMALL_WORDS = new Set([
  'on', 'the', 'a', 'an', 'of', 'in', 'at', 'to', 'and', 'or', 'for', 'with',
]);

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Saniyeyi damgaya çevirir: `0:00`, `3:19`, `1:02:03`.
 *
 * AŞAĞI yuvarlanır. Yukarı yuvarlama damgayı parçanın gerçek başlangıcından
 * sonraya iter; tıklayan dinleyici parçanın ilk anını kaçırır.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Geçersiz damga süresi: ${seconds}`);
  }

  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Parçanın görünen adı: names eşlemesi varsa o, yoksa dosya adından türetilir.
 *
 *   "rain-on-the-glass [usesuno.com].m4a" → "Rain on the Glass"
 *   "2 [usesuno.com].m4a" + { "2": "Before Light" } → "Before Light"
 *
 * @param {string} path
 * @param {Record<string, string>} [names] dosya adı (sade) → görünen ad
 * @returns {string}
 */
export function trackName(path, names = {}) {
  const key = normalizeName(basename(path));

  for (const [alias, label] of Object.entries(names)) {
    if (normalizeName(alias) === key) return label;
  }

  return titleCase(key);
}

/**
 * Başlık büyütmesi. İlk kelime her zaman büyür; SMALL_WORDS'teki bağlaç ve
 * edatlar araya düştüklerinde küçük kalır:
 *   "rain on the glass" → "Rain on the Glass"
 *
 * @param {string} text normalizeName çıktısı (küçük harf, boşlukla ayrılmış)
 * @returns {string}
 */
function titleCase(text) {
  return text
    .split(' ')
    .map((word, index) =>
      index > 0 && SMALL_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * Manifest parçalarından tracklist metnini ve bölüm denetimini üretir.
 * Saf fonksiyon — dosya yazmaz.
 *
 * @param {Array<{ file: string, startSeconds: number, duration: number|null, repeat?: boolean }>} tracks
 *   `repeat`: kısa Pomodoro müziğinde baştan tekrar çalan parça — adına " (tekrar)" eklenir
 * @param {{ names?: Record<string, string> }} [options]
 * @returns {{
 *   text: string,
 *   entries: Array<{ stamp: string, name: string, file: string, startSeconds: number, duration: number|null }>,
 *   youtubeChapters: boolean,
 *   warnings: string[],
 * }}
 */
/** Tekrar çalan parçanın tracklist'teki eki. */
export const REPEAT_SUFFIX = ' (tekrar)';

export function buildTracklist(tracks, options = {}) {
  const { names = {} } = options;

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Tracklist için parça yok.');
  }

  const entries = tracks.map((track) => ({
    stamp: formatTimestamp(track.startSeconds),
    name: track.repeat ? `${trackName(track.file, names)}${REPEAT_SUFFIX}` : trackName(track.file, names),
    file: track.file,
    startSeconds: track.startSeconds,
    duration: track.duration,
  }));

  const warnings = checkChapters(entries);
  const text = entries.map((e) => `${e.stamp}${SEPARATOR}${e.name}`).join('\n') + '\n';

  return { text, entries, youtubeChapters: warnings.length === 0, warnings };
}

/**
 * YouTube bölüm şartlarını denetler. Her ihlal ayrı bir uyarı satırı.
 * @param {Array<{ stamp: string, name: string, startSeconds: number, duration: number|null }>} entries
 * @returns {string[]}
 */
function checkChapters(entries) {
  const warnings = [];
  const { minChapters, minChapterSeconds } = CHAPTER_RULES;

  if (entries[0].stamp !== '0:00') {
    warnings.push(`İlk damga 0:00 değil (${entries[0].stamp}) — YouTube bölümleri tanımaz.`);
  }
  if (entries.length < minChapters) {
    warnings.push(
      `${entries.length} parça var; YouTube bölüm için en az ${minChapters} damga istiyor.`,
    );
  }

  entries.forEach((entry, i) => {
    const next = entries[i + 1];

    if (next && Math.floor(next.startSeconds) <= Math.floor(entry.startSeconds)) {
      warnings.push(
        `"${entry.name}" ve "${next.name}" aynı damgaya düşüyor (${entry.stamp}) — ` +
        'damgalar kesin artan olmalı.',
      );
      return; // aynı ihlal için ayrıca "0 sn" uyarısı basma
    }

    // Bölüm uzunluğu damgalar arası farktır; son parçada kendi süresi.
    const length = next
      ? Math.floor(next.startSeconds) - Math.floor(entry.startSeconds)
      : entry.duration;
    if (length !== null && length !== undefined && length < minChapterSeconds) {
      warnings.push(
        `"${entry.name}" ${Number(length.toFixed(1))} sn — YouTube bölümü en az ` +
        `${minChapterSeconds} sn olmalı.`,
      );
    }
  });

  return warnings;
}

/**
 * Tracklist'i üretir ve dosyaya yazar (BOM'suz, LF).
 *
 * @param {object} options
 * @param {Array<{ file: string, startSeconds: number, duration: number|null }>} options.tracks
 *   02-audio-concat.js manifest'indeki `tracks`
 * @param {string} options.outputPath
 * @param {Record<string, string>} [options.names]
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @returns {Promise<object>} rapor
 */
export async function writeTracklist(options) {
  const { tracks, outputPath, names, logger = NOOP_LOGGER } = options;

  const tracklist = buildTracklist(tracks, { names });
  for (const warning of tracklist.warnings) logger.warn(warning);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeTextFile(outputPath, tracklist.text);

  logger.info(
    `Tracklist yazıldı: ${tracklist.entries.length} parça` +
    (tracklist.youtubeChapters ? ', YouTube bölüm şartlarına uyuyor.' : '.'),
  );

  return {
    output: outputPath,
    count: tracklist.entries.length,
    entries: tracklist.entries,
    youtubeChapters: tracklist.youtubeChapters,
    warnings: tracklist.warnings,
  };
}
