/**
 * Aşama 2 — Ses zinciri.
 *
 * Parçaları tek bir mix dosyasına çevirir:
 *   topla → duplike ele → sırala → ölç → birleştir → doğrula → manifest
 *
 * TEK YOL: concat filtresi + AAC/48 kHz/stereo encode (2026-09-14, Aşama 6 P4).
 * Önceki concat demuxer yolu (ve AAC için `-c copy` beyaz listesi) ilk dosyadan
 * sonraki her dosyanın encoder priming / pre-skip örneklerini atmıyordu — ölçüldü:
 * 15 parçada AAC kopyada +373 ms, Opus encode'da +206 ms kayma. Filtre her girdiyi
 * kendi çözücüsünde açtığı için kayma sıfır. Süre de aynı (gerçek albümde 106 vs
 * 104 sn).
 *
 * Bu katman "ne yapılacağını" bilir; süreç yönetimi core/ffmpeg.js'in,
 * ölçüm core/probe.js'in, dosya sistemi core/files.js'in işi.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { listFiles, findDuplicates, matchOrder } from '../core/files.js';
import { durationsMatch, measureDecodedDuration, probe } from '../core/probe.js';

/** Çıktı her zaman bu biçimde (referans videodaki değerler). */
/**
 * Çıktı her zaman bu biçimde. Ara dosya: sıkıştırılmamış float WAV — ses
 * yalnız montajda bir kez AAC'ye encode edilir (her encode küçük bir kayıp).
 */
const TARGET = { codec: 'pcm_f32le', sampleRate: 48000, channels: 2 };

/**
 * Bir dosyanın başlık süresi ile çözülen süresi arasında kabul edilen en büyük
 * fark (sn). Normali encoder gecikmesi: Opus +13.5 ms, AAC +21–27 ms. Yarısı
 * kesilmiş dosyada fark 10 sn ölçüldü.
 */
const DAMAGED_FILE_GAP = 0.5;
/** Aynı anda en çok bu kadar ölçüm süreci (ffprobe/ffmpeg); fazlası diski ve CPU'yu boğar. */
const MEASURE_CONCURRENCY = 8;

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Ses parçalarını tek dosyada birleştirir.
 *
 * @param {object} options
 * @param {string} options.audioDir parçaların bulunduğu klasör
 * @param {string} options.outputPath üretilecek mix dosyası
 * @param {string[]} [options.order] parça sırası (sade adlar, ör. "midnight-window");
 *   verilirse orderFile'dan önce gelir
 * @param {string} [options.orderFile] order.txt yolu (ikisi de yoksa alfabetik sıraya düşülür)
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} manifest
 */
export async function concatAudio(options) {
  const {
    audioDir,
    outputPath,
    order,
    orderFile,
    logger = NOOP_LOGGER,
    onProgress,
  } = options;

  const warnings = [];
  /** @param {string} message */
  const warn = (message) => {
    warnings.push(message);
    logger.warn(message);
  };

  // 1 — Topla
  const found = await listFiles(audioDir);
  if (found.length === 0) {
    throw new Error(`Ses dosyası bulunamadı: ${audioDir}`);
  }
  logger.info(`${found.length} ses dosyası bulundu.`);

  // 2 — Duplike ele (içeriğe göre, isme göre değil)
  const { unique, duplicates } = await findDuplicates(found);
  for (const duplicate of duplicates) {
    warn(
      `Duplike atlandı: "${basename(duplicate.path)}" ` +
      `= "${basename(duplicate.sameAs)}" (md5 ${duplicate.md5.slice(0, 8)}…)`,
    );
  }

  // 3 — Sırala
  const { ordered, sortSource, orderReport } = await resolveOrder(
    unique,
    { order, orderFile },
    warn,
  );

  // 4 — Ölç: biçim probe'dan, SÜRE çözülen örnek sayısından (probe süresi
  // encoder gecikmesi yüzünden dosya başına ~13 ms sapıyor, damgalar kayıyordu).
    // Dosya başına ayrı ffprobe/ffmpeg süreci: sırayla 100 parçada dakikalar sürüyordu.
  const probes = await mapLimited(ordered, MEASURE_CONCURRENCY, (path) => probe(path));

  const missingAudio = probes.filter((p) => !p.hasAudio);
  if (missingAudio.length > 0) {
    throw new Error(
      `Ses akışı olmayan dosya(lar): ${missingAudio.map((p) => basename(p.path)).join(', ')}`,
    );
  }

  const decoded = await mapLimited(probes, MEASURE_CONCURRENCY, async (p) => {
    const seconds = await measureDecodedDuration(p.path);
    // Başlık ile gerçek ses arasındaki normal fark encoder gecikmesi kadar (13–27 ms).
    // Saniyeler mertebesinde fark: dosya kesik ya da bozuk — yarım parça albüme girmesin.
    if (p.duration !== null && Math.abs(seconds - p.duration) > DAMAGED_FILE_GAP) {
      throw new Error(
        `"${basename(p.path)}" bozuk ya da kesik olabilir: başlık ${p.duration.toFixed(2)} sn ` +
        `diyor, çözülebilen ses ${seconds.toFixed(2)} sn. Dosyayı yeniden indir/dışa aktar.`,
      );
    }
    return seconds;
  });

  const kinds = [...new Set(probes.map((p) => `${p.audioCodec}/${p.sampleRate}/${p.channels}`))];
  logger.info(
    `Girdiler: ${kinds.join(', ')} → concat filtresi, ${TARGET.codec}/${TARGET.sampleRate}/` +
    `${TARGET.channels} (her durumda encode).`,
  );

  // 5 — Birleştir
  await mkdir(dirname(outputPath), { recursive: true });
  await ffmpeg(buildFilterArgs(probes, outputPath), { onProgress });

  // 6 — Doğrula (beklenen: çözülen sürelerin toplamı)
  const result = await probe(outputPath);
  const expectedDuration = decoded.reduce((sum, d) => sum + d, 0);

  if (!durationsMatch(result.duration, expectedDuration)) {
    throw new Error(
      `Mix süresi beklenenden farklı: ${result.duration} sn üretildi, ` +
      `${expectedDuration.toFixed(3)} sn bekleniyordu. Çıktı güvenilir değil.`,
    );
  }
  if (result.sampleRate !== TARGET.sampleRate || result.channels !== TARGET.channels) {
    throw new Error(
      `Mix biçimi hedeften farklı: ${result.sampleRate} Hz / ${result.channels} kanal.`,
    );
  }

  // 7 — Manifest (05-tracklist.js damgaları ve adları buradan üretir, dosyaları yeniden ölçmez)
  let elapsed = 0;
  const tracks = probes.map((p, i) => {
    const track = {
      file: p.path,
      duration: decoded[i],
      probeDuration: p.duration,
      startSeconds: elapsed,
      codec: p.audioCodec,
      sampleRate: p.sampleRate,
      channels: p.channels,
    };
    elapsed += decoded[i];
    return track;
  });

  return {
    output: outputPath,
    duration: result.duration,
    expectedDuration,
    durationDelta: Number((result.duration - expectedDuration).toFixed(3)),
    format: {
      codec: result.audioCodec,
      sampleRate: result.sampleRate,
      channels: result.channels,
      size: result.size,
    },
    tracks,
    duplicates,
    sortSource,
    orderReport,
    codec: { action: 'encode', method: 'filter', inputs: kinds },
    warnings,
  };
}

/**
 * Sıralamayı belirler. Öncelik: `order` dizisi (project.json) → order.txt →
 * alfabetik. Alfabetiğe düşüş asla sessiz değildir — bu albümde alfabetik
 * sıra yanlıştı — ama build'i de durdurmaz.
 *
 * @param {string[]} paths
 * @param {{ order?: string[], orderFile?: string }} source
 * @param {(message: string) => void} warn
 */
async function resolveOrder(paths, { order, orderFile }, warn) {
  let lines = null;
  let label = null;

  if (Array.isArray(order) && order.length > 0) {
    lines = order;
    label = 'order';
  } else if (orderFile) {
    try {
      lines = (await readFile(orderFile, 'utf8')).split(/\r?\n/);
      label = 'order.txt';
    } catch {
      warn(`order.txt okunamadı: ${orderFile}`);
    }
  }

  if (lines === null) {
    warn(
      'Parça sırası verilmedi (project.json "order" / order.txt) — dosyalar ' +
      'alfabetik/doğal sıraya göre dizildi. Albüm sırası alfabetik DEĞİLDİR ' +
      '(gece → sabah konsepti elle kurulur); çıktıyı dinlemeden yayınlama.',
    );
    return {
      ordered: paths,
      sortSource: 'alphabetical',
      orderReport: null,
    };
  }

  const report = matchOrder(lines, paths);

  for (const { line, lineNumber } of report.unmatchedLines) {
    warn(`${label} satır ${lineNumber}: "${line}" hiçbir dosyayla eşleşmedi.`);
  }
  for (const { line, lineNumber, candidates } of report.ambiguousLines) {
    warn(
      `${label} satır ${lineNumber}: "${line}" birden fazla dosyaya uyuyor ` +
      `(${candidates.map((c) => basename(c)).join(', ')}). Satır atlandı.`,
    );
  }
  if (report.unlistedFiles.length > 0) {
    warn(
      `${label} içinde geçmeyen ${report.unlistedFiles.length} dosya sona eklendi: ` +
      `${report.unlistedFiles.map((f) => basename(f)).join(', ')}`,
    );
  }

  return {
    ordered: report.ordered,
    sortSource: label,
    orderReport: {
      unmatchedLines: report.unmatchedLines,
      ambiguousLines: report.ambiguousLines,
      unlistedFiles: report.unlistedFiles,
    },
  };
}

/**
 * Bir girdiyi ortak biçime çeken filtre dalı.
 *
 * Neden her girdi ayrı: concat filtresi karışık girdilerde ortak kanal düzenini
 * KENDİSİ seçiyor ve mono + stereo'da mono seçiyor — stereo parça sessizce
 * mono'ya iniyordu (ölçüldü: L 500 / R 900 Hz → 896 / 896).
 *
 * Mono için `pan`, `aformat` değil: aformat mono→stereo çoğaltırken merkez
 * karışımıyla 3 dB düşürüyor (ölçüldü: −21.07 → −24.08 dB); pan seviyeyi korur.
 * İkiden fazla kanal standart stereo downmix'e iner.
 *
 * @param {number} index
 * @param {{ channels: number|null }} input
 */
export function normalizeBranch(index, input) {
  const layout = input.channels === 1
    ? 'pan=stereo|c0=c0|c1=c0,'
    : '';
  return (
    `[${index}:a]aresample=${TARGET.sampleRate},${layout}` +
    `aformat=sample_fmts=fltp:sample_rates=${TARGET.sampleRate}:channel_layouts=stereo[a${index}]`
  );
}

/**
 * items'ı en çok `limit` eşzamanlı işle eşler; sonuç sırası girdi sırasıdır.
 * İlk hatada yeni iş başlatılmaz, süren işler (ffmpeg süreçleri dosyaları açık
 * tutuyor) bitene kadar beklenir, sonra ilk hata fırlatılır.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * concat filtresi argümanları: her girdi ayrı açılır (priming doğru atılır),
 * ortak biçime çekilir, tek geçişte float WAV'a yazılır.
 *
 * @param {Array<{ path: string, channels: number|null }>} inputs
 * @param {string} outputPath
 */
function buildFilterArgs(inputs, outputPath) {
  const branches = inputs.map((input, i) => normalizeBranch(i, input));
  const labels = inputs.map((_, i) => `[a${i}]`).join('');

  return [
    ...inputs.flatMap((input) => ['-i', input.path]),
    '-filter_complex',
    `${branches.join(';')};${labels}concat=n=${inputs.length}:v=0:a=1[out]`,
    '-map', '[out]',
    '-vn',
    '-c:a', TARGET.codec,
    '-ar', String(TARGET.sampleRate),
    '-ac', String(TARGET.channels),
    '-y', outputPath,
  ];
}
