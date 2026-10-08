/**
 * Shorts kesit planı — `project.json` → `shorts` bloğunun tek yorumlayıcısı.
 *
 * Tek sorumluluk: saf hesap. Kaynak videodaki zaman aralıklarını ve 9:16
 * kadraj oranlarını doğrulayıp ffmpeg'in anlayacağı piksel değerlerine
 * çevirir. Dosya okumaz, yazmaz, ffmpeg çalıştırmaz (onlar
 * `prep/shorts-file.js` ve `steps/08-shorts-export.js`).
 *
 * Neden ayrı modül: kaynak video KOPYALANMIYOR — kesit "aynı dosyanın şu
 * aralığı" referansıdır. Aralık ve kadraj kuralları hem UI'da (önizleme),
 * hem API'de (doğrulama), hem render'da (ffmpeg) aynı olmak zorunda; üç
 * yerde ayrı kopya zamanla birbirinden sapardı (`core/ambient-plan.js` ile
 * aynı gerekçe).
 */

/** Shorts hedefi: dikey 1080×1920 (9:16). */
export const SHORTS_TARGET = { width: 1080, height: 1920, aspect: '9:16' };

/** Kadraj oranı — kesitin genişlik/yükseklik oranı. */
export const SHORTS_RATIO = SHORTS_TARGET.width / SHORTS_TARGET.height;

/** Bir kesitin kabul edilen süre aralığı (saniye). */
export const MIN_CLIP_SECONDS = 1;
/** YouTube Shorts üst sınırı; aşan kesit uyarı alır, engellenmez. */
export const MAX_SHORTS_SECONDS = 180;

/** Yakınlaştırma sınırları — 1 = sığan en büyük 9:16 kutu. */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;

/** Kadraj varsayılanı: ortada, yakınlaştırma yok. */
export const DEFAULT_FRAME = { zoom: 1, x: 0.5, y: 0.5 };

export class ShortsPlanError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ShortsPlanError';
  }
}

/** Saniyeyi 3 ondalığa yuvarlar (kare altı gürültü project.json'a yazılmasın). */
function roundSeconds(value) {
  return Math.round(value * 1000) / 1000;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

/**
 * Kadraj oranlarını (zoom + merkez) kaynak videodaki piksel kutusuna çevirir.
 *
 * `zoom = 1` kaynağa sığan EN BÜYÜK 9:16 kutudur: yatay videoda tüm yükseklik,
 * dikey videoda tüm genişlik. Büyük zoom kutuyu küçültür (yakınlaşma).
 * `x`/`y` 0–1 arası: kutunun kayabileceği boşluktaki konumu (0 = sol/üst,
 * 0.5 = orta, 1 = sağ/alt).
 *
 * Çift sayı zorunlu: libx264 yuv420p'de tek sayılı en/boy kabul etmiyor.
 *
 * @param {{ sourceWidth: number, sourceHeight: number, zoom?: number, x?: number, y?: number }} input
 * @returns {{ width: number, height: number, x: number, y: number }} piksel
 */
export function computeShortsCrop({ sourceWidth, sourceHeight, zoom = 1, x = 0.5, y = 0.5 }) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
    || sourceWidth < 2 || sourceHeight < 2) {
    throw new ShortsPlanError(`Kaynak video ölçüsü okunamadı (${sourceWidth}×${sourceHeight}).`);
  }

  const safeZoom = clamp(toNumber(zoom) ?? 1, MIN_ZOOM, MAX_ZOOM);
  const sourceRatio = sourceWidth / sourceHeight;
  // Sığan en büyük 9:16 kutu: geniş kaynakta yükseklik, dikey kaynakta genişlik sınırlar.
  const baseHeight = sourceRatio > SHORTS_RATIO ? sourceHeight : sourceWidth / SHORTS_RATIO;
  const baseWidth = baseHeight * SHORTS_RATIO;

  const width = evenDown(clamp(baseWidth / safeZoom, 2, sourceWidth));
  const height = evenDown(clamp(baseHeight / safeZoom, 2, sourceHeight));

  const offsetX = evenDown((sourceWidth - width) * clamp(toNumber(x) ?? 0.5, 0, 1));
  const offsetY = evenDown((sourceHeight - height) * clamp(toNumber(y) ?? 0.5, 0, 1));

  return { width, height, x: offsetX, y: offsetY };
}

/** Aşağıya yuvarlanmış çift sayı. */
function evenDown(value) {
  return Math.max(0, Math.floor(value / 2) * 2);
}

/**
 * Kesit için ffmpeg video filtresi: kırp → 1080×1920'ye ölçekle.
 *
 * `scale` kutuyu tam hedefe getirir (kutu zaten 9:16 olduğu için en-boy
 * bozulmaz); `setsar=1` kare piksel garantisi — bazı kaynaklarda SAR 1 değil
 * ve oynatıcı videoyu yanlış genişlikte gösteriyor.
 *
 * @param {{ width: number, height: number, x: number, y: number }} crop
 * @returns {string}
 */
export function buildShortsFilter(crop) {
  return [
    `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
    `scale=${SHORTS_TARGET.width}:${SHORTS_TARGET.height}:flags=lanczos`,
    'setsar=1',
  ].join(',');
}

/**
 * Bir kesidi normalleştirir. Dönen `problems` boş değilse kesit render
 * edilemez; `warnings` yalnızca bilgi (ör. Shorts süresini aşmak).
 *
 * @param {unknown} raw project.json'daki kayıt ya da API gövdesi
 * @param {{ index?: number, sourceDuration?: number|null }} [context]
 * @returns {{ clip: object|null, problems: string[], warnings: string[] }}
 */
export function normalizeShortsClip(raw, { index = 0, sourceDuration = null } = {}) {
  const problems = [];
  const warnings = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { clip: null, problems: [`${index + 1}. kesit bir nesne olmalı`], warnings };
  }

  const label = typeof raw.title === 'string' && raw.title.trim() !== ''
    ? raw.title.trim()
    : `Shorts ${String(index + 1).padStart(2, '0')}`;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]+$/.test(raw.id) ? raw.id : null;
  if (id === null) problems.push(`${label}: kesit kimliği (id) harf/rakam/-/_ olmalı`);

  const start = toNumber(raw.start);
  const end = toNumber(raw.end);
  if (start === null || start < 0) problems.push(`${label}: başlangıç zamanı geçersiz`);
  if (end === null) problems.push(`${label}: bitiş zamanı geçersiz`);

  let duration = null;
  if (start !== null && end !== null && start >= 0) {
    duration = roundSeconds(end - start);
    if (duration < MIN_CLIP_SECONDS) {
      problems.push(`${label}: kesit en az ${MIN_CLIP_SECONDS} sn olmalı (şu an ${duration} sn)`);
    }
    if (duration > MAX_SHORTS_SECONDS) {
      warnings.push(`${label}: ${Math.round(duration)} sn — YouTube Shorts sınırı ${MAX_SHORTS_SECONDS} sn.`);
    }
    if (sourceDuration !== null && end > sourceDuration + 0.5) {
      problems.push(`${label}: bitiş (${roundSeconds(end)} sn) kaynak videodan uzun (${roundSeconds(sourceDuration)} sn)`);
    }
  }

  const frameRaw = raw.frame !== null && typeof raw.frame === 'object' ? raw.frame : {};
  const frame = {
    zoom: clamp(toNumber(frameRaw.zoom) ?? DEFAULT_FRAME.zoom, MIN_ZOOM, MAX_ZOOM),
    x: clamp(toNumber(frameRaw.x) ?? DEFAULT_FRAME.x, 0, 1),
    y: clamp(toNumber(frameRaw.y) ?? DEFAULT_FRAME.y, 0, 1),
  };

  if (problems.length > 0) return { clip: null, problems, warnings };

  return {
    clip: {
      id,
      title: label,
      start: roundSeconds(start),
      end: roundSeconds(end),
      duration,
      frame,
      /** Render çıktısının dosya adı — `out/shorts/` altında. */
      output: typeof raw.output === 'string' && raw.output.trim() !== ''
        ? raw.output.trim()
        : clipOutputName(id, label),
      renderedAt: typeof raw.renderedAt === 'string' ? raw.renderedAt : null,
    },
    problems,
    warnings,
  };
}

/**
 * `shorts` bloğunun tamamı. Bozuk kesitler atılır ama sessizce değil:
 * `problems` kullanıcıya gösterilir (konfig hatası gizlenmez).
 *
 * @param {unknown} shortsBlock
 * @param {{ sourceDuration?: number|null }} [context]
 * @returns {{ source: string|null, clips: object[], problems: string[], warnings: string[] }}
 */
export function normalizeShortsPlan(shortsBlock, { sourceDuration = null } = {}) {
  if (shortsBlock === null || shortsBlock === undefined) {
    return { source: null, clips: [], problems: [], warnings: [] };
  }
  if (typeof shortsBlock !== 'object' || Array.isArray(shortsBlock)) {
    return { source: null, clips: [], problems: ['shorts bir nesne olmalı'], warnings: [] };
  }

  const source = typeof shortsBlock.source === 'string' && shortsBlock.source.trim() !== ''
    ? shortsBlock.source.trim()
    : null;
  const rawClips = Array.isArray(shortsBlock.clips) ? shortsBlock.clips : [];

  const clips = [];
  const problems = [];
  const warnings = [];
  const seenIds = new Set();

  for (const [index, raw] of rawClips.entries()) {
    const result = normalizeShortsClip(raw, { index, sourceDuration });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
    if (!result.clip) continue;
    if (seenIds.has(result.clip.id)) {
      problems.push(`${result.clip.title}: aynı kimlik iki kez kullanılmış (${result.clip.id})`);
      continue;
    }
    seenIds.add(result.clip.id);
    clips.push(result.clip);
  }

  // Zaman sırası: kullanıcı aralıkları karışık eklese de liste videodaki
  // sırayla görünür (eklenme sırası bir anlam taşımıyor).
  clips.sort((a, b) => a.start - b.start || a.end - b.end);
  return { source, clips, problems, warnings };
}

/**
 * Diske yazılacak biçim — varsayılandan sapmayan alan yazılmaz
 * (`serializeAmbientPlan` ile aynı kural: dosya okunabilir kalsın).
 *
 * @param {{ source: string|null, clips: object[] }} plan
 * @returns {object}
 */
export function serializeShortsPlan({ source, clips }) {
  return {
    ...(source ? { source } : {}),
    clips: clips.map((clip) => ({
      id: clip.id,
      title: clip.title,
      start: roundSeconds(clip.start),
      end: roundSeconds(clip.end),
      ...(isDefaultFrame(clip.frame) ? {} : {
        frame: {
          zoom: Math.round(clip.frame.zoom * 1000) / 1000,
          x: Math.round(clip.frame.x * 1000) / 1000,
          y: Math.round(clip.frame.y * 1000) / 1000,
        },
      }),
      output: clip.output,
      ...(clip.renderedAt ? { renderedAt: clip.renderedAt } : {}),
    })),
  };
}

function isDefaultFrame(frame) {
  return frame.zoom === DEFAULT_FRAME.zoom && frame.x === DEFAULT_FRAME.x && frame.y === DEFAULT_FRAME.y;
}

/**
 * Çıktı dosya adı: başlıktan türetilir, Windows'ta geçerli kalsın diye
 * harf/rakam dışı her şey tireye iner. Başlık tamamen özel karakterse
 * kimlik kullanılır.
 *
 * @param {string} id
 * @param {string} title
 */
export function clipOutputName(id, title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[ğ]/g, 'g').replace(/[ü]/g, 'u').replace(/[ş]/g, 's')
    .replace(/[ı]/g, 'i').replace(/[ö]/g, 'o').replace(/[ç]/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || id}.mp4`;
}

/**
 * Yeni kesit için kullanılmayan kimlik: `kesit-01`, `kesit-02`…
 * @param {object[]} clips
 */
export function nextClipId(clips) {
  const used = new Set(clips.map((clip) => clip.id));
  for (let counter = 1; counter < 1000; counter++) {
    const id = `kesit-${String(counter).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new ShortsPlanError('Kesit kimliği üretilemedi (1000 sınırı).');
}

/**
 * Yeni kesit için varsayılan başlık: `Shorts 01`, `Shorts 02`…
 * @param {object[]} clips
 */
export function nextClipTitle(clips) {
  const used = new Set(clips.map((clip) => clip.title.toLowerCase()));
  for (let counter = 1; counter < 1000; counter++) {
    const title = `Shorts ${String(counter).padStart(2, '0')}`;
    if (!used.has(title.toLowerCase())) return title;
  }
  return `Shorts ${clips.length + 1}`;
}

/** `00:04:21.5` biçiminde okunur damga (tracklist biçimiyle aynı mantık). */
export function formatTimecode(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const body = `${String(minutes).padStart(2, '0')}:${secs.toFixed(1).padStart(4, '0')}`;
  return hours > 0 ? `${hours}:${body}` : body;
}
