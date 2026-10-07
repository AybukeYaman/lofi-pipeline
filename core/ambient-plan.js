/**
 * Ambiance seçimi → normalize edilmiş karıştırma planı.
 *
 * Tek sorumluluk: `project.json`'daki `ambient` alanının birbirinden farklı
 * yazım şekillerini TEK bir plan nesnesine çevirmek ve her parçanın hedef
 * seviyesini hesaplamak. Dosya sistemine dokunmaz, ffmpeg çağırmaz, ses
 * ölçmez — karıştırma `steps/03-ambient-mix.js`'in işi, yolların çözülmesi
 * `core/config.js`'in.
 *
 * Neden ayrı modül: `ambient` alanı üç farklı şekilde yazılabiliyor (tek
 * metin, metin dizisi, nesne) ve ileride MusicHub kalkıp Ambiance tek müzik
 * kaynağı olduğunda mod listesi büyüyecek. O büyüme burada tek bir kayıt
 * eklemekle olsun diye şekil çözümleme karıştırmadan ayrıldı.
 *
 * Kabul edilen şekiller (üçü de aynı plana çıkar):
 *   "ambient": "rain"
 *   "ambient": ["rain", "fire"]
 *   "ambient": {
 *     "mode": "layer",          // layer | sequence — varsayılan layer
 *     "crossfade": 2,           // loop dikişinde harmanlanacak saniye
 *     "volumeDb": -20,          // bütün parçalar için ofset (audio.ambientOffsetDb'yi ezer)
 *     "tracks": ["rain", { "path": "fire", "volumeDb": -24 }]
 *   }
 */

/**
 * Çoklu Ambiance kullanım modları.
 *
 * - `layer`: parçalar aynı anda üst üste çalar; her biri kendi uzunluğunda
 *   bağımsız döner. Tek parça seçildiğinde de bu mod çalışır.
 * - `sequence`: parçalar sırayla çalar, aralarında crossfade; liste bitince
 *   başa döner. Döngünün tamamı tek bir "loop birimi" sayılır.
 *
 * Yeni mod eklemek: buraya adı yaz, `steps/03-ambient-mix.js` içindeki
 * `buildLoopUnit` dağıtımına bir dal ekle. Başka yer bilmek zorunda değil.
 */
export const AMBIENT_MODES = ['layer', 'sequence'];

/** Bugünkü davranışı koruyan varsayılan: hepsi aynı anda. */
export const DEFAULT_AMBIENT_MODE = 'layer';

/**
 * Loop dikişinde harmanlanan süre (sn).
 *
 * 0 verilirse dikiş sert eklenir (eski davranış, her tekrarda tık duyulur).
 * 2 sn ortam sesleri için duyulmaz bir geçiş veriyor; parça bu kadar kısaysa
 * karıştırma adımı değeri kendiliğinden küçültür.
 */
export const DEFAULT_CROSSFADE_SECONDS = 2;

/** Ambiance'ın baştan açılma süresi (sn) — ani başlamayı engeller. */
export const DEFAULT_FADE_IN_SECONDS = 2;

/** `volumeDb` için kabul edilen aralık — `audio.ambientOffsetDb` ile aynı. */
const VOLUME_DB_RANGE = { min: -60, max: 0 };

/** Crossfade üst sınırı: bundan uzun harman ortam sesini belirsizleştiriyor. */
const CROSSFADE_RANGE = { min: 0, max: 30 };

/**
 * @typedef {object} AmbientTrack
 * @property {string} path Ses dosyası — `core/config.js` mutlak yola çevirir.
 * @property {number|null} volumeDb Bu parçaya özel ofset; null ise plan ya da
 *   `audio.ambientOffsetDb` devreye girer.
 */

/**
 * @typedef {object} AmbientPlan
 * @property {'layer'|'sequence'} mode
 * @property {number} crossfade
 * @property {number|null} volumeDb Plan geneli ofset; null ise config'in değeri.
 * @property {AmbientTrack[]} tracks En az bir parça.
 */

/**
 * Ham `ambient` alanını plana çevirir.
 *
 * Hata atmaz: `core/config.js` bütün sorunları toplayıp tek seferde
 * raporladığı için sorunlar dizi olarak döner. Parça seçilmemişse (alan yok,
 * boş dizi, boş `tracks`) `plan: null` döner — ambient adımı atlanır.
 *
 * @param {unknown} raw `project.json`'daki `ambient` değeri
 * @param {string} [field] hata mesajlarında kullanılacak alan adı
 * @returns {{ plan: AmbientPlan|null, problems: string[] }}
 */
export function normalizeAmbientSelection(raw, field = 'ambient') {
  const problems = [];

  if (raw === undefined || raw === null) return { plan: null, problems };

  const shape = readShape(raw, field, problems);
  if (shape === null) return { plan: null, problems };

  const mode = readMode(shape.mode, `${field}.mode`, problems);
  const crossfade = readNumber(
    shape.crossfade, `${field}.crossfade`, CROSSFADE_RANGE, DEFAULT_CROSSFADE_SECONDS, problems,
  );
  const volumeDb = readNumber(
    shape.volumeDb, `${field}.volumeDb`, VOLUME_DB_RANGE, null, problems,
  );
  const tracks = readTracks(shape.tracks, field, problems);

  if (tracks.length === 0) return { plan: null, problems };

  return { plan: { mode, crossfade, volumeDb, tracks }, problems };
}

/**
 * Bir parçanın ulaşması gereken ofset — özelden genele: parça → plan → config.
 *
 * Ofset müziğin ÖLÇÜLEN seviyesine göre bir FARK (LU), mutlak bir hedef değil;
 * mutlak hedefi `core/loudness.js` `targetLoudnessFor` hesaplar.
 *
 * @param {AmbientTrack} track
 * @param {AmbientPlan} plan
 * @param {number} configOffsetDb `audio.ambientOffsetDb`
 * @returns {number}
 */
export function offsetDbFor(track, plan, configOffsetDb) {
  return track.volumeDb ?? plan.volumeDb ?? configOffsetDb;
}

/**
 * Planı `project.json`'a yazılacak en yalın şekle indirir.
 *
 * Varsayılandan sapmayan alan yazılmaz: tek parça + varsayılan ayar yine
 * `"ambient": "rain"` olarak kalır, eski projelerin dosyası şişmez.
 *
 * @param {AmbientPlan|null} plan
 * @returns {string|string[]|object|undefined} undefined → alanı hiç yazma
 */
export function serializeAmbientPlan(plan) {
  if (plan === null) return undefined;

  const plain =
    plan.mode === DEFAULT_AMBIENT_MODE &&
    plan.crossfade === DEFAULT_CROSSFADE_SECONDS &&
    plan.volumeDb === null &&
    plan.tracks.every((track) => track.volumeDb === null);

  if (plain) {
    const paths = plan.tracks.map((track) => track.path);
    return paths.length === 1 ? paths[0] : paths;
  }

  return {
    ...(plan.mode === DEFAULT_AMBIENT_MODE ? {} : { mode: plan.mode }),
    ...(plan.crossfade === DEFAULT_CROSSFADE_SECONDS ? {} : { crossfade: plan.crossfade }),
    ...(plan.volumeDb === null ? {} : { volumeDb: plan.volumeDb }),
    tracks: plan.tracks.map((track) =>
      track.volumeDb === null ? track.path : { path: track.path, volumeDb: track.volumeDb }),
  };
}

// ---------------------------------------------------------------- yardımcılar

/** Bilinen anahtarlar — `tracs` gibi yazım hatası sessizce yok sayılmasın. */
const KNOWN_OBJECT_KEYS = ['mode', 'crossfade', 'volumeDb', 'tracks'];

/**
 * Üç yazım şeklini ortak bir ara şekle indirir: `{ mode?, crossfade?,
 * volumeDb?, tracks }`. Şekil hiç tanınmazsa null.
 */
function readShape(raw, field, problems) {
  if (typeof raw === 'string') return { tracks: [raw] };
  if (Array.isArray(raw)) return { tracks: raw };

  if (typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      if (!KNOWN_OBJECT_KEYS.includes(key)) {
        problems.push(`${field}.${key}: bilinmeyen alan (beklenen: ${KNOWN_OBJECT_KEYS.join(', ')})`);
      }
    }
    if (raw.tracks === undefined) {
      problems.push(`${field}.tracks: nesne şekli kullanılıyorsa zorunlu`);
      return null;
    }
    if (!Array.isArray(raw.tracks)) {
      problems.push(`${field}.tracks: dizi olmalı`);
      return null;
    }
    return raw;
  }

  problems.push(`${field}: metin, metin dizisi ya da { mode, tracks } nesnesi olmalı`);
  return null;
}

function readMode(value, field, problems) {
  if (value === undefined || value === null) return DEFAULT_AMBIENT_MODE;
  if (!AMBIENT_MODES.includes(value)) {
    problems.push(
      `${field}: ${AMBIENT_MODES.map((m) => `"${m}"`).join(' ya da ')} olmalı ` +
      `(verilen: ${JSON.stringify(value)})`,
    );
    return DEFAULT_AMBIENT_MODE;
  }
  return value;
}

function readNumber(value, field, { min, max }, fallback, problems) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${field}: sayı olmalı (verilen: ${JSON.stringify(value)})`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${field}: ${min} ile ${max} arasında olmalı (verilen: ${value})`);
    return fallback;
  }
  return value;
}

/**
 * Parça listesi. Her öğe metin ya da `{ path, volumeDb? }`.
 * Aynı dosya iki kez verilirse ikincisi atılır — `layer` modunda aynı sesi
 * üst üste koymak yalnızca seviyeyi yükseltir, kullanıcının istediği bu değil.
 */
function readTracks(raw, field, problems) {
  const tracks = [];
  const seen = new Set();

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const label = `${field}[${i}]`;

    let path = null;
    let volumeDb = null;

    if (typeof item === 'string') {
      path = item.trim();
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of Object.keys(item)) {
        if (key !== 'path' && key !== 'volumeDb') {
          problems.push(`${label}.${key}: bilinmeyen alan (beklenen: path, volumeDb)`);
        }
      }
      path = typeof item.path === 'string' ? item.path.trim() : null;
      if (path === null) problems.push(`${label}.path: boş olmayan bir metin olmalı`);
      volumeDb = readNumber(item.volumeDb, `${label}.volumeDb`, VOLUME_DB_RANGE, null, problems);
    } else {
      problems.push(`${label}: metin ya da { path, volumeDb } nesnesi olmalı`);
      continue;
    }

    if (!path) {
      if (typeof item === 'string') problems.push(`${label}: boş olmayan bir metin olmalı`);
      continue;
    }

    const key = path.toLowerCase();
    if (seen.has(key)) {
      problems.push(`${label}: "${path}" listede iki kez var`);
      continue;
    }
    seen.add(key);
    tracks.push({ path, volumeDb });
  }

  return tracks;
}
