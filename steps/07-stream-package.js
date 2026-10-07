/**
 * Aşama 7 — Yayın paketi (24/7 canlı yayın için albüm).
 *
 * Uzun videoyu render etmek yerine YAYININ MALZEMESİNİ üretir: kısa döngü
 * arka planı + parçalar. Yayın tarafı (YT Stream System) döngüyü kendisi
 * tekrarlayıp parçaları sırayla çalıyor ve ekrana parça adını basıyor; yani
 * 4 saatlik mp4'ü üretmenin yayın için hiçbir karşılığı yok. Ölçüldü: aynı
 * projede render 10.4 GB, paket 215 MB (48 kat), montaj adımı da build
 * süresinin %45-92'si.
 *
 * Paket sözleşmesi (yayın tarafının kodundan doğrulandı — değiştirme):
 *
 *   <albüm>/background.mp4   h264, 1280x720, 24 fps, SES YOK, kısa döngü
 *   <albüm>/music/*.m4a      YALNIZCA .m4a — başka uzantı sessizce yok sayılır
 *
 * Dosya adı yayında ekranda görünen parça adıdır: numara/önek eklenmez.
 * Sıra dosya adına göre alfabetiktir, karıştırmayı yayın tarafı yapar.
 *
 * Bu modül YALNIZCA `music-source/` altına yazar; yayın sisteminin hiçbir
 * dosyasına dokunmaz.
 */

import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { isImagePath } from '../core/files.js';
import { probe } from '../core/probe.js';
import { planAspectCrop } from './01-video-prep.js';
import { trackName } from './05-tracklist.js';

/**
 * Arka plan profili — yayın tarafının `profile` ayarıyla aynı.
 *
 * Yayın zaten üstüne yazı bastığı için videoyu yeniden kodluyor; yine de
 * çözünürlük/fps uyuşursa ölçekleme maliyeti kalmıyor. Ses YOK: arka plan
 * yalnızca görüntü, müzik ayrı geliyor.
 */
export const STREAM_PROFILE = {
  width: 1280,
  height: 720,
  fps: 24,
  /** Döngü kısa ve tekrar ediyor; 20 bu ölçekte gözle ayırt edilmiyor. */
  crf: 20,
  preset: 'veryfast',
  /** Tek resim modunda üretilecek döngü uzunluğu (sn) — mevcut albümler 8 sn. */
  stillSeconds: 8,
};

/** Yayın tarafı başka uzantıya bakmıyor. */
export const TRACK_EXTENSION = '.m4a';

/** Parçalar bu biçimde yazılır (kaynak zaten buysa kopyalanır). */
const TRACK_TARGET = { codec: 'aac', bitrate: '192k', sampleRate: 48000, channels: 2 };

/** Yarım kalmış paket canlı dizine girmesin diye önce buraya yazılır. */
export const STAGING_DIR = '.staging';

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Yayın paketini üretir.
 *
 * @param {object} options
 * @param {string} options.clipPath döngü klibi ya da tek resim
 * @param {'clip'|'image'} options.videoSource
 * @param {{ bottom: number, top: number, left: number, right: number }} options.crop
 * @param {string|null} options.aspect
 * @param {string[]} options.trackPaths parça dosyaları
 * @param {Record<string, string>} [options.names] dosya adı → görünen ad
 * @param {string} options.outDir paketin projedeki kopyası (out/stream-package)
 * @param {string|null} [options.streamerDir] yayın tarafının `music-source` kökü
 * @param {string} options.album albüm adı (çakışırsa sürüm eki alır)
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} rapor
 */
export async function buildStreamPackage(options) {
  const {
    clipPath,
    videoSource,
    crop,
    aspect,
    trackPaths,
    names = {},
    outDir,
    streamerDir = null,
    album,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  if (trackPaths.length === 0) throw new Error('Yayın paketi için parça yok.');

  // 1 — Albüm adı. Var olan albümün İÇİNİ değiştirmek yasak: yayın tarafının
  // parça önbelleği dosya SAYISINA bakıyor, aynı sayıda parçayı değiştirsek
  // eski listeyi çalmaya devam ederdi. Çakışmada yeni sürüm adı alınır.
  const albumName = streamerDir
    ? await freeAlbumName(streamerDir, album, warn)
    : album;

  // 2 — Paketi önce projenin kendi klasörüne kur (canlı okunmayan yer).
  const packageDir = join(outDir, albumName);
  await rm(packageDir, { recursive: true, force: true });
  const musicDir = join(packageDir, 'music');
  await mkdir(musicDir, { recursive: true });

  const background = await writeBackground({
    clipPath, videoSource, crop, aspect,
    outputPath: join(packageDir, 'background.mp4'),
    logger, onProgress,
  });

  const tracks = await writeTracks({ trackPaths, names, musicDir, logger, warn });

  logger.info(
    `Paket hazır: ${albumName} — arka plan ${background.width}x${background.height}` +
    `/${background.fps} fps/${background.duration.toFixed(1)} sn, ${tracks.length} parça.`,
  );

  // 3 — Yayın tarafına atomik taşıma: music-source canlı okunuyor, yarım
  // yazılmış bir klasör eksik parçalı albüm olarak yayına girerdi.
  let published = null;
  if (streamerDir) {
    published = await publishAtomically({ packageDir, streamerDir, albumName, logger });
  }

  return {
    album: albumName,
    requestedAlbum: album,
    dir: packageDir,
    published,
    background,
    tracks,
    totalBytes: background.bytes + tracks.reduce((sum, t) => sum + t.bytes, 0),
    warnings,
  };
}

/**
 * Albümün içini değiştirmek yerine boş bir ad bulur: `ad`, `ad-v2`, `ad-v3`…
 *
 * @param {string} streamerDir
 * @param {string} album
 * @param {(message: string) => void} warn
 */
async function freeAlbumName(streamerDir, album, warn) {
  for (let version = 1; version < 100; version++) {
    const candidate = version === 1 ? album : `${album}-v${version}`;
    if (!(await exists(join(streamerDir, candidate)))) {
      if (version > 1) {
        warn(
          `"${album}" albümü yayın tarafında zaten var — içeriği değiştirmek yerine ` +
          `"${candidate}" olarak yazıldı (yayın tarafı parça listesini dosya sayısına ` +
          'göre önbelleğe alıyor, yerinde değişiklik fark edilmezdi).',
        );
      }
      return candidate;
    }
  }
  throw new Error(`"${album}" için boş albüm adı bulunamadı (v99'a kadar dolu).`);
}

/**
 * Arka plan döngüsü: kırpma → en-boy → profil çözünürlüğü, ses yok.
 *
 * Kırpma ve en-boy mantığı montajdakiyle aynı kaynaktan (`planAspectCrop`):
 * yayındaki görüntü ile render edilen videonun çerçevesi ayrı düşmesin.
 */
async function writeBackground({ clipPath, videoSource, crop, aspect, outputPath, logger, onProgress }) {
  const isStill = videoSource === 'image' || isImagePath(clipPath);
  const source = await probe(clipPath);

  if (!isStill && !source.hasVideo) {
    throw new Error(`Döngü klibinde video akışı yok: ${clipPath}`);
  }

  const croppedWidth = source.width - crop.left - crop.right;
  const croppedHeight = source.height - crop.top - crop.bottom;

  const filters = [];
  if (crop.top > 0 || crop.bottom > 0 || crop.left > 0 || crop.right > 0) {
    filters.push(`crop=${croppedWidth}:${croppedHeight}:${crop.left}:${crop.top}`);
  }
  if (aspect) {
    const plan = planAspectCrop({ width: croppedWidth, height: croppedHeight, aspect });
    if (!plan.skipped && plan.filter) filters.push(plan.filter);
  }
  // Profil boyutu: kırpma sonrası görüntü bu çerçeveye oturtulur. Oran zaten
  // 16:9'a getirildiği için `scale` görüntüyü esnetmez.
  filters.push(`scale=${STREAM_PROFILE.width}:${STREAM_PROFILE.height}`);
  filters.push(`fps=${STREAM_PROFILE.fps}`);

  const input = isStill
    ? ['-loop', '1', '-t', String(STREAM_PROFILE.stillSeconds), '-i', clipPath]
    : ['-i', clipPath];

  await ffmpeg([
    ...input,
    '-vf', filters.join(','),
    // Ses YOK: arka plan yalnızca görüntü.
    '-an',
    '-c:v', 'libx264',
    '-crf', String(STREAM_PROFILE.crf),
    '-preset', STREAM_PROFILE.preset,
    '-pix_fmt', 'yuv420p',
    // Döngü dikişi temiz olsun: her saniye bir anahtar kare, sahne kesmesi
    // kaynaklı kayan GOP yok — yayın tarafı başa sardığında zıplama olmaz.
    '-g', String(STREAM_PROFILE.fps),
    '-keyint_min', String(STREAM_PROFILE.fps),
    '-sc_threshold', '0',
    '-movflags', '+faststart',
    '-y', outputPath,
  ], { onProgress });

  const result = await probe(outputPath);
  if (result.hasAudio) {
    throw new Error('Arka planda ses akışı var — yayın tarafı sessiz arka plan bekliyor.');
  }
  logger.info(
    `Arka plan: ${source.width}x${source.height} → ${result.width}x${result.height}, ` +
    `${result.duration.toFixed(1)} sn, ${(result.size / 1e6).toFixed(1)} MB.`,
  );

  return {
    path: outputPath,
    width: result.width,
    height: result.height,
    fps: Math.round(result.fps ?? STREAM_PROFILE.fps),
    duration: result.duration,
    bytes: result.size,
    fromStill: isStill,
  };
}

/**
 * Parçaları `music/` altına yazar.
 *
 * Dosya adı ekranda görünen ad olduğu için `names` eşlemesi ve başlık
 * büyütmesi burada da geçerli (tracklist ile aynı kaynak: `trackName`).
 * Zaten AAC/.m4a olan dosya yeniden kodlanmaz — her encode küçük bir kayıp.
 */
async function writeTracks({ trackPaths, names, musicDir, logger, warn }) {
  const used = new Set();
  const tracks = [];
  let copied = 0;
  let encoded = 0;

  for (const path of trackPaths) {
    const info = await probe(path);
    if (!info.hasAudio) {
      warn(`Ses akışı yok, pakete alınmadı: ${basename(path)}`);
      continue;
    }

    const name = uniqueName(screenName(path, names), used);
    const target = join(musicDir, `${name}${TRACK_EXTENSION}`);

    // Kapsayıcı .m4a OLSA DA içerik Opus olabiliyor (bölüm 8) — kopyalama
    // kararı uzantıya değil ölçülen codec'e bakar.
    const canCopy = info.audioCodec === TRACK_TARGET.codec
      && extname(path).toLowerCase() === TRACK_EXTENSION;

    if (canCopy) {
      await copyFile(path, target);
      copied++;
    } else {
      await ffmpeg([
        '-i', path,
        '-vn',
        '-c:a', TRACK_TARGET.codec,
        '-b:a', TRACK_TARGET.bitrate,
        '-ar', String(TRACK_TARGET.sampleRate),
        '-ac', String(TRACK_TARGET.channels),
        '-movflags', '+faststart',
        '-y', target,
      ]);
      encoded++;
    }

    const written = await stat(target);
    tracks.push({
      source: path,
      file: `${name}${TRACK_EXTENSION}`,
      name,
      duration: info.duration,
      sourceCodec: info.audioCodec,
      action: canCopy ? 'copy' : 'encode',
      bytes: written.size,
    });
  }

  if (tracks.length === 0) throw new Error('Pakete hiç parça yazılamadı.');
  logger.info(`Parçalar: ${copied} kopyalandı, ${encoded} yeniden kodlandı (${TRACK_EXTENSION}).`);
  return tracks;
}

/**
 * Aynı görünen ada sahip ikinci parça dosyayı ezmesin.
 * @param {string} name
 * @param {Set<string>} used
 */
function uniqueName(name, used) {
  const safe = displayName(name);
  if (!used.has(safe.toLowerCase())) {
    used.add(safe.toLowerCase());
    return safe;
  }
  for (let n = 2; ; n++) {
    const candidate = `${safe} (${n})`;
    if (!used.has(candidate.toLowerCase())) {
      used.add(candidate.toLowerCase());
      return candidate;
    }
  }
}

/**
 * Yayında ekranda görünecek parça adı.
 *
 * Dosya adı zaten okunur yazılmışsa (boşluklu, köşeli parantez artığı yok,
 * sıra öneki yok) olduğu gibi kullanılır. Ölçüldü: gerçek albümde kaynak adlar
 * "Amber Curtains, 952 PM" gibi; tracklist'in başlık büyütmesinden geçirince
 * "Amber Curtains 952 Pm" oluyordu — kullanıcının yazdığı ad bozuluyor.
 *
 * Okunur olmayan adlar (`rain-on-the-glass [usesuno.com].m4a`, `2.m4a`)
 * tracklist ile AYNI yoldan geçer: `names` eşlemesi, köşeli parantez
 * temizliği ve başlık büyütmesi orada.
 *
 * @param {string} path
 * @param {Record<string, string>} names
 * @returns {string}
 */
export function screenName(path, names) {
  const raw = takeSuffix(basename(path, extname(path))).replace(/_/g, ' ');
  const readable = /\s/.test(raw) && !/[[\]]/.test(raw) && !/^\d{1,3}\s*[-–]/.test(raw);
  return displayName(readable ? raw : trackName(path, names));
}

/**
 * Aynı parçanın ikinci kaydı: `<ad>_1` → `<ad> (Take 2)`.
 *
 * Üretim tarafı alternatif kayıtları `_1`, `_2` ile ayırıyor ama bu bir
 * dosya adı artığı, parçanın adı değil. Mevcut albümlerde yerleşik gelenek
 * "(Take 2)" (bkz. `cozyAutumnIstanbulvideo10`); ekranda "Amber Cursor 1"
 * değil "Amber Cursor (Take 2)" görünmeli.
 *
 * `_1` ilk alternatif olduğu için Take 2'dir: asıl kayıt zaten Take 1.
 * Yalnızca sondaki numara dönüştürülür — ad içinde geçen alt çizgi boşluğa
 * çevrilmeye devam eder.
 *
 * @param {string} name uzantısız dosya adı
 * @returns {string}
 */
export function takeSuffix(name) {
  return name.replace(/_(\d{1,2})$/, (_, n) => ` (Take ${Number(n) + 1})`);
}

/**
 * Ekranda görünecek ada hazırlar.
 *
 * İki iş: sıra numarası önekini atar ve dosya adında kullanılamayan
 * karakterleri temizler. Önek atılıyor çünkü bu ad yayında İZLEYİCİYE
 * gösteriliyor — "02 Rain on the Glass" değil "Rain on the Glass" yazmalı.
 * Tracklist tarafı bundan ayrı: orada damga zaten sırayı veriyor.
 *
 * Yalnızca baştaki 1-3 haneli numara atılır ve geriye bir ad kalıyorsa:
 * "1979" gibi gerçekten sayı olan bir parça adı silinmez.
 */
export function displayName(name) {
  const withoutIndex = name.replace(/^\d{1,3}(?=\s)\s*/, '');
  const base = withoutIndex.trim() === '' ? name : withoutIndex;
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'track' : cleaned;
}

/**
 * Paketi yayın tarafına ATOMİK koyar.
 *
 * `music-source/` canlı okunuyor ve bir albüm "background.mp4 + music/ var"
 * diye geçerli sayılıyor; yarım kopyalanmış bir klasör eksik parçalı albüm
 * olarak yayına girerdi. Bu yüzden önce nokta ile başlayan (taranmayan)
 * `.staging/` altına kopyalanır, bitince TEK `rename` ile yerine alınır.
 *
 * Yayın tarafının sözleşmesi yalnızca `background.mp4` ve `music/*.m4a`
 * diyor; tracklist/rapor gibi ek dosyalar projenin kendi klasöründe kalır.
 */
async function publishAtomically({ packageDir, streamerDir, albumName, logger }) {
  const staging = join(streamerDir, STAGING_DIR, albumName);
  const target = join(streamerDir, albumName);

  // Önceki çöken çalışmadan kalmış olabilir.
  await rm(staging, { recursive: true, force: true });
  await mkdir(join(staging, 'music'), { recursive: true });

  await copyFile(join(packageDir, 'background.mp4'), join(staging, 'background.mp4'));
  const musicDir = join(packageDir, 'music');
  for (const file of await readdir(musicDir)) {
    await copyFile(join(musicDir, file), join(staging, 'music', file));
  }

  await rename(staging, target);
  // .staging kökü boş kaldıysa bırakılır: bir sonraki çalışma yeniden kullanır.
  logger.info(`Yayın tarafına alındı: ${target}`);
  return { dir: target, staging };
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}
