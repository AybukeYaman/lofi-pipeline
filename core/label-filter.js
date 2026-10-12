/**
 * Etiket planı → ffmpeg `drawtext` zinciri.
 *
 * Tek sorumluluk: saf metin üretimi. Dosya yazmaz, ffmpeg çalıştırmaz, font
 * dosyasını aramaz (onlar `steps/04a-label-overlay.js`). Girdi
 * `core/label-plan.js` çıktısıdır; Pomodoro zamanları `core/pomodoro-plan.js`
 * `buildTimeline().sessions` olarak DIŞARIDAN verilir ve yalnızca OKUNUR —
 * burada hiçbir süre/oturum hesabı yapılmaz, zamanlama kararı sistemde kalır.
 *
 * Konum: etiketin MERKEZİ `w*x`, `h*y`; metin kenara taşmasın diye
 * `[0, w-text_w]` aralığına kıstırılır. Arayüzdeki önizleme aynı formülü
 * kullanır (`web/src/labelFrame.ts`) — ikisi birlikte değişir.
 */

import { isSystemLabel } from './label-plan.js';

/** Pomodoro oturum türü → ekrandaki yazı (canlı yayındaki STUDY/BREAK ile aynı). */
export const STATUS_TEXT = { work: 'STUDY', break: 'BREAK' };

/** Filtre değeri için yol kaçışı: ters bölü → /, `:` → `\:` (Windows `C:/...`). */
export function escapeFilterPath(path) {
  return String(path).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** Yazı boyutu piksel olarak: video yüksekliğinin oranı, en az 8 px. */
export function labelFontPixels(size, height) {
  return Math.max(8, Math.round(size * height));
}

/** drawtext konum ifadeleri (merkez + kenara kıstırma). Tek tırnak içinde kullanılır. */
export function positionExpressions({ x, y }) {
  return {
    x: `max(0,min(w-text_w,w*${x}-text_w/2))`,
    y: `max(0,min(h-text_h,h*${y}-text_h/2))`,
  };
}

/** Ortak görünüm: font, boyut, renk, konum, gölge. */
function style(label, { fontFile, height }) {
  const pos = positionExpressions(label);
  return [
    `fontfile='${escapeFilterPath(fontFile)}'`,
    `fontsize=${labelFontPixels(label.size, height)}`,
    `fontcolor=${label.color}`,
    `x='${pos.x}'`,
    `y='${pos.y}'`,
    'shadowcolor=black@0.6', 'shadowx=2', 'shadowy=2',
  ].join(':');
}

function enableBetween(start, end) {
  return `enable='between(t,${start},${end})'`;
}

/**
 * Geri sayım ifadesi: oturumun bitişine kalan süre `dd:dd` (ffmpeg kendi
 * zaman damgasından hesaplar — sayı başına dosya/drawtext gerekmez).
 * `ceil` ile 00:00 yalnızca geçiş anında görünür.
 */
function countdownText(endSeconds) {
  const rem = `ceil(${endSeconds}-t)`;
  return `%{eif\\:trunc(${rem}/60)\\:d\\:2}\\:%{eif\\:mod(${rem},60)\\:d\\:2}`;
}

/**
 * @param {{
 *   labels: object[],
 *   height: number,
 *   fontFile: string,
 *   sessions?: Array<{ kind: 'work'|'break', startSeconds: number, endSeconds: number }>|null,
 *   textPath: (name: string) => string,
 * }} input
 *   `sessions`: Pomodoro kapalıysa null — sistem etiketleri atlanır ve raporlanır.
 *   `textPath`: metin dosyasının MUTLAK yolu (çağıran yazar).
 * @returns {{ filter: string|null, files: Array<{ name: string, content: string }>, skipped: string[] }}
 *   `filter` etiket yoksa null: çağıran eski davranışı aynen sürdürür.
 */
export function buildLabelFilter({ labels, height, fontFile, sessions = null, textPath }) {
  const parts = [];
  const files = [];
  const skipped = [];

  for (const label of labels) {
    const look = style(label, { fontFile, height });

    if (label.kind === 'text') {
      const name = `label-${label.id}.txt`;
      files.push({ name, content: label.text });
      const enable = label.start !== null && label.end !== null
        ? `:${enableBetween(label.start, label.end)}`
        : '';
      parts.push(`drawtext=${look}:expansion=none:textfile='${escapeFilterPath(textPath(name))}'${enable}`);
      continue;
    }

    if (!isSystemLabel(label.kind)) continue;
    if (!sessions || sessions.length === 0) {
      skipped.push(`${label.id} (${label.kind}): Pomodoro kapalı, etiket atlandı`);
      continue;
    }

    if (label.kind === 'pomodoro-countdown') {
      for (const session of sessions) {
        parts.push(
          `drawtext=${look}:text='${countdownText(session.endSeconds)}'` +
          `:${enableBetween(session.startSeconds, session.endSeconds)}`,
        );
      }
      continue;
    }

    // pomodoro-status: iki sabit metin dosyası, oturum başına bir drawtext
    // (yalnızca kendi aralığında görünür).
    const names = {};
    for (const kind of ['work', 'break']) {
      names[kind] = `label-${label.id}-${STATUS_TEXT[kind].toLowerCase()}.txt`;
      files.push({ name: names[kind], content: STATUS_TEXT[kind] });
    }
    for (const session of sessions) {
      parts.push(
        `drawtext=${look}:expansion=none:textfile='${escapeFilterPath(textPath(names[session.kind]))}'` +
        `:${enableBetween(session.startSeconds, session.endSeconds)}`,
      );
    }
  }

  return { filter: parts.length > 0 ? parts.join(',') : null, files, skipped };
}
