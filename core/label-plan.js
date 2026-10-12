/**
 * Video üstü etiket planı — `project.json` → `labels` dizisinin tek yorumlayıcısı.
 *
 * Tek sorumluluk: saf doğrulama/normalleştirme. Dosya okumaz/yazmaz, ffmpeg
 * çalıştırmaz, Pomodoro zamanlamasını bilmez (onlar `prep/project-file.js`,
 * `core/label-filter.js` ve `core/pomodoro-plan.js`). Etiketin GÖRSEL durumu
 * (nerede, ne büyüklükte, ne renkte) burada; ne zaman ve ne yazacağı ise
 * sistemde kalır — konum değişikliği zamanlama/durum mantığına dokunmaz.
 *
 * İki tür etiket:
 *   - `text`: kullanıcının yazdığı serbest metin. İsteğe bağlı `start`/`end`
 *     (sn) verilirse yalnızca o aralıkta görünür, yoksa videonun tamamında.
 *   - `pomodoro-status` / `pomodoro-countdown`: SİSTEM etiketleri (STUDY/BREAK
 *     ve geri sayım). Metin ve zaman Pomodoro planından gelir; burada yalnızca
 *     konum/boyut/renk tutulur. Her türden en fazla bir tane olur.
 *
 * Konum oranlıdır (0–1, etiketin MERKEZİ), piksel değil: aynı kayıt 16:9
 * ana videoda da 9:16 Shorts'ta da çözünürlükten bağımsız geçerli kalır
 * (`core/shorts-plan.js` kadrajıyla aynı gerekçe). Kayıt yoksa (`labels`
 * alanı hiç yazılmamış) sonuç boş listedir ve hiçbir davranış değişmez.
 */

export const LABEL_KINDS = ['text', 'pomodoro-status', 'pomodoro-countdown'];

/** Metni ve zamanı sistemden gelen türler — kullanıcı yalnızca görünümünü ayarlar. */
export const SYSTEM_LABEL_KINDS = ['pomodoro-status', 'pomodoro-countdown'];

/** Yazı boyutu: video YÜKSEKLİĞİNİN oranı (0.05 = 720p'de 36 px). */
export const MIN_LABEL_SIZE = 0.02;
export const MAX_LABEL_SIZE = 0.2;
export const DEFAULT_LABEL_SIZE = 0.05;

export const DEFAULT_LABEL_COLOR = '#ffffff';
export const MAX_LABEL_TEXT_LENGTH = 120;

/** Yeni etiketin başlangıç konumu: sistem etiketleri sağ üstte alt alta (canlı yayındaki düzen). */
const DEFAULT_POSITIONS = {
  text: { x: 0.5, y: 0.9 },
  'pomodoro-countdown': { x: 0.9, y: 0.07 },
  'pomodoro-status': { x: 0.9, y: 0.14 },
};

export class LabelPlanError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'LabelPlanError';
  }
}

/** Sistem etiketi mi (otomatik yönetilen)? */
export function isSystemLabel(kind) {
  return SYSTEM_LABEL_KINDS.includes(kind);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Sonlu sayı mı? (`"12"` de kabul edilir — project.json elle yazılabiliyor) */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `#rgb` / `#rrggbb` → küçük harfli `#rrggbb`; geçersizse null. */
function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : null;
}

/** Satır sonu/kontrol karakteri atılır: drawtext tek satırlık metin bekliyor. */
function cleanText(value) {
  return typeof value === 'string'
    // eslint-disable-next-line no-control-regex
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

/**
 * Bir etiketi normalleştirir. `problems` boş değilse etiket atılır;
 * `warnings` yalnızca bilgi.
 *
 * @param {unknown} raw project.json'daki kayıt ya da API gövdesi
 * @param {{ index?: number }} [context]
 * @returns {{ label: object|null, problems: string[], warnings: string[] }}
 */
export function normalizeLabel(raw, { index = 0 } = {}) {
  const problems = [];
  const warnings = [];
  const name = `${index + 1}. etiket`;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { label: null, problems: [`${name} bir nesne olmalı`], warnings };
  }

  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : null;
  if (id === null) problems.push(`${name}: kimlik (id) harf/rakam/-/_ olmalı`);

  const kind = raw.kind === undefined ? 'text' : raw.kind;
  if (!LABEL_KINDS.includes(kind)) {
    problems.push(`${name}: tür ${LABEL_KINDS.join(' | ')} olmalı (verilen: ${JSON.stringify(kind)})`);
  }
  const system = isSystemLabel(kind);

  let text = '';
  if (kind === 'text') {
    text = cleanText(raw.text);
    if (text === '') problems.push(`${name}: metin boş olamaz`);
    if (text.length > MAX_LABEL_TEXT_LENGTH) {
      warnings.push(`${name}: metin ${MAX_LABEL_TEXT_LENGTH} karaktere kısaltıldı`);
      text = text.slice(0, MAX_LABEL_TEXT_LENGTH).trim();
    }
  }

  // Zaman aralığı yalnızca serbest metinde: sistem etiketlerinin zamanı Pomodoro planından gelir.
  let start = null;
  let end = null;
  if (system) {
    if (raw.start !== undefined && raw.start !== null || raw.end !== undefined && raw.end !== null) {
      warnings.push(`${name}: sistem etiketinin zamanı Pomodoro planından gelir, start/end yok sayıldı`);
    }
  } else {
    const rawStart = raw.start === undefined || raw.start === null ? null : toNumber(raw.start);
    const rawEnd = raw.end === undefined || raw.end === null ? null : toNumber(raw.end);
    const hasStart = raw.start !== undefined && raw.start !== null;
    const hasEnd = raw.end !== undefined && raw.end !== null;
    if (hasStart !== hasEnd) {
      problems.push(`${name}: başlangıç ve bitiş birlikte verilmeli (ya da ikisi de boş)`);
    } else if (hasStart) {
      if (rawStart === null || rawStart < 0) problems.push(`${name}: başlangıç zamanı geçersiz`);
      else if (rawEnd === null) problems.push(`${name}: bitiş zamanı geçersiz`);
      else if (rawEnd <= rawStart) problems.push(`${name}: bitiş başlangıçtan sonra olmalı`);
      else {
        start = round(rawStart, 3);
        end = round(rawEnd, 3);
      }
    }
  }

  const defaults = DEFAULT_POSITIONS[kind] ?? DEFAULT_POSITIONS.text;
  const label = {
    id,
    kind,
    text,
    x: clamp(toNumber(raw.x) ?? defaults.x, 0, 1),
    y: clamp(toNumber(raw.y) ?? defaults.y, 0, 1),
    size: clamp(toNumber(raw.size) ?? DEFAULT_LABEL_SIZE, MIN_LABEL_SIZE, MAX_LABEL_SIZE),
    color: normalizeColor(raw.color) ?? DEFAULT_LABEL_COLOR,
    start,
    end,
  };
  if (raw.color !== undefined && normalizeColor(raw.color) === null) {
    warnings.push(`${name}: renk #rrggbb olmalı, ${DEFAULT_LABEL_COLOR} kullanıldı`);
  }

  if (problems.length > 0) return { label: null, problems, warnings };
  return { label, problems, warnings };
}

/**
 * `labels` dizisinin tamamı. Bozuk kayıtlar atılır ama sessizce değil:
 * `problems` kullanıcıya gösterilir (konfig hatası gizlenmez).
 *
 * @param {unknown} labelsBlock `project.json` → `labels`
 * @returns {{ labels: object[], problems: string[], warnings: string[] }}
 */
export function normalizeLabelPlan(labelsBlock) {
  if (labelsBlock === null || labelsBlock === undefined) {
    return { labels: [], problems: [], warnings: [] };
  }
  if (!Array.isArray(labelsBlock)) {
    return { labels: [], problems: ['labels bir dizi olmalı'], warnings: [] };
  }

  const labels = [];
  const problems = [];
  const warnings = [];
  const seenIds = new Set();
  const seenSystemKinds = new Set();

  for (const [index, raw] of labelsBlock.entries()) {
    const result = normalizeLabel(raw, { index });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    const { label } = result;
    if (!label) continue;
    if (seenIds.has(label.id)) {
      problems.push(`${index + 1}. etiket: aynı kimlik iki kez kullanılmış (${label.id})`);
      continue;
    }
    if (isSystemLabel(label.kind) && seenSystemKinds.has(label.kind)) {
      problems.push(`${index + 1}. etiket: ${label.kind} yalnızca bir kez eklenebilir`);
      continue;
    }
    seenIds.add(label.id);
    if (isSystemLabel(label.kind)) seenSystemKinds.add(label.kind);
    labels.push(label);
  }
  return { labels, problems, warnings };
}

/**
 * Diske yazılacak biçim — varsayılandan sapmayan alan yazılmaz
 * (`serializeShortsPlan` ile aynı kural: dosya okunabilir kalsın).
 * Boş liste `[]` döner; çağıran bunu "alanı sil" diye yorumlayabilir.
 *
 * @param {object[]} labels normalizeLabelPlan çıktısı
 * @returns {object[]}
 */
export function serializeLabelPlan(labels) {
  // Konum her zaman yazılır: varsayılan köşe sonradan değişirse kullanıcının yeri kaymasın.
  return labels.map((label) => ({
    id: label.id,
    ...(label.kind === 'text' ? { text: label.text } : { kind: label.kind }),
    x: round(label.x, 4),
    y: round(label.y, 4),
    ...(label.size === DEFAULT_LABEL_SIZE ? {} : { size: round(label.size, 4) }),
    ...(label.color === DEFAULT_LABEL_COLOR ? {} : { color: label.color }),
    ...(label.start !== null && label.end !== null ? { start: label.start, end: label.end } : {}),
  }));
}

/**
 * Yeni etiket için kullanılmayan kimlik: `etiket-01`, `etiket-02`…
 * @param {object[]} labels
 */
export function nextLabelId(labels) {
  const used = new Set(labels.map((label) => label.id));
  for (let counter = 1; counter < 1000; counter++) {
    const id = `etiket-${String(counter).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new LabelPlanError('Etiket kimliği üretilemedi (1000 sınırı).');
}

/**
 * Verilen türde yeni, geçerli bir etiket (varsayılan konum/boyut/renkle).
 * Sistem etiketi zaten varsa hata verir.
 *
 * @param {object[]} labels mevcut liste
 * @param {{ kind?: string, text?: string }} [options]
 */
export function createLabel(labels, { kind = 'text', text = 'Yeni etiket' } = {}) {
  if (!LABEL_KINDS.includes(kind)) {
    throw new LabelPlanError(`Etiket türü ${LABEL_KINDS.join(' | ')} olmalı (verilen: ${JSON.stringify(kind)}).`);
  }
  if (isSystemLabel(kind) && labels.some((label) => label.kind === kind)) {
    throw new LabelPlanError(`${kind} etiketi zaten var.`);
  }
  const { label, problems } = normalizeLabel({ id: nextLabelId(labels), kind, text }, { index: labels.length });
  if (!label) throw new LabelPlanError(problems.join(' · '));
  return label;
}
