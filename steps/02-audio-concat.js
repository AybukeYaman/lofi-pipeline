/**
 * Aşama 2 — Ses zinciri.
 *
 * 15 parçayı tek bir mix dosyasına çevirir:
 *   topla → duplike ele → sırala → codec kararı → birleştir → doğrula → manifest
 *
 * Bu katman "ne yapılacağını" bilir; süreç yönetimi core/ffmpeg.js'in,
 * ölçüm core/probe.js'in, dosya sistemi core/files.js ve core/workspace.js'in işi.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { ffmpeg } from '../core/ffmpeg.js';
import { concatLine, listFiles, findDuplicates, matchOrder } from '../core/files.js';
import { durationsMatch, probe } from '../core/probe.js';

/**
 * Yeniden encode edilmeden doğrudan kopyalanabilecek girdinin tarifi.
 *
 * Bilinçli olarak BEYAZ liste: "Opus ise encode et" gibi bir kara liste,
 * yarın ALAC veya Vorbis geldiğinde sessizce yanlış yola sapar.
 * Burada listede olmayan her şey encode edilir — bilinmeyen girdi güvenli
 * tarafa düşer.
 */
const COPY_WHITELIST = { codec: 'aac' };

/** Varsayılan çıktı hedefi (referans videodaki değerler). */
const DEFAULTS = { bitrate: '192k', sampleRate: 48000, channels: 2 };

const NOOP_LOGGER = { info() {}, warn() {} };

/**
 * Ses parçalarını tek dosyada birleştirir.
 *
 * @param {object} options
 * @param {string} options.audioDir parçaların bulunduğu klasör
 * @param {string} options.outputPath üretilecek mix dosyası
 * @param {import('../core/workspace.js').createWorkspace extends
 *   (...args: any) => Promise<infer W> ? W : never} options.workspace
 * @param {string} [options.orderFile] order.txt yolu (yoksa alfabetik sıraya düşülür)
 * @param {string} [options.bitrate]
 * @param {number} [options.sampleRate]
 * @param {number} [options.channels]
 * @param {{ info: Function, warn: Function }} [options.logger]
 * @param {(seconds: number) => void} [options.onProgress]
 * @returns {Promise<object>} manifest
 */
export async function concatAudio(options) {
  const {
    audioDir,
    outputPath,
    workspace,
    orderFile,
    bitrate = DEFAULTS.bitrate,
    sampleRate = DEFAULTS.sampleRate,
    channels = DEFAULTS.channels,
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
    orderFile,
    warn,
  );

  // 4 — Ölç (gerçek codec burada öğrenilir, uzantıya güvenilmez)
  const probes = [];
  for (const path of ordered) {
    probes.push(await probe(path));
  }

  const missingAudio = probes.filter((p) => !p.hasAudio);
  if (missingAudio.length > 0) {
    throw new Error(
      `Ses akışı olmayan dosya(lar): ${missingAudio.map((p) => basename(p.path)).join(', ')}`,
    );
  }

  // 5 — Codec kararı
  const decision = decideCodec(probes, { sampleRate, channels });
  logger.info(`Codec kararı: ${decision.action} (${decision.reason})`);

  // 6 — Birleştir
  await mkdir(dirname(outputPath), { recursive: true });

  const args = decision.method === 'demuxer'
    ? await buildDemuxerArgs(ordered, workspace, outputPath, decision, { bitrate, sampleRate, channels })
    : buildFilterArgs(ordered, outputPath, { bitrate, sampleRate, channels });

  await ffmpeg(args, { onProgress });

  // 7 — Doğrula
  const result = await probe(outputPath);
  const expectedDuration = probes.reduce((sum, p) => sum + (p.duration ?? 0), 0);

  if (!durationsMatch(result.duration, expectedDuration)) {
    throw new Error(
      `Mix süresi beklenenden farklı: ${result.duration} sn üretildi, ` +
      `${expectedDuration.toFixed(2)} sn bekleniyordu. Çıktı güvenilir değil.`,
    );
  }

  // 8 — Manifest (05-tracklist.js damgaları ve adları buradan üretir, dosyaları yeniden ölçmez)
  let elapsed = 0;
  const tracks = probes.map((p) => {
    const track = {
      file: p.path,
      duration: p.duration,
      startSeconds: elapsed,
      codec: p.audioCodec,
      sampleRate: p.sampleRate,
      channels: p.channels,
    };
    elapsed += p.duration ?? 0;
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
    codec: decision,
    warnings,
  };
}

/**
 * Sıralamayı belirler: order.txt varsa ondan, yoksa alfabetik sıraya düşer.
 * Alfabetiğe düşüş asla sessiz değildir — bu albümde alfabetik sıra yanlıştı.
 *
 * @param {string[]} paths
 * @param {string|undefined} orderFile
 * @param {(message: string) => void} warn
 */
async function resolveOrder(paths, orderFile, warn) {
  let lines = null;

  if (orderFile) {
    try {
      lines = (await readFile(orderFile, 'utf8')).split(/\r?\n/);
    } catch {
      warn(`order.txt okunamadı: ${orderFile}`);
    }
  }

  if (lines === null) {
    warn(
      'order.txt yok — dosyalar alfabetik/doğal sıraya göre dizildi. ' +
      'Albüm sırası alfabetik DEĞİLDİR (gece → sabah konsepti elle kurulur); ' +
      'çıktıyı dinlemeden yayınlama.',
    );
    return {
      ordered: paths,
      sortSource: 'alphabetical',
      orderReport: null,
    };
  }

  const report = matchOrder(lines, paths);

  for (const { line, lineNumber } of report.unmatchedLines) {
    warn(`order.txt satır ${lineNumber}: "${line}" hiçbir dosyayla eşleşmedi.`);
  }
  for (const { line, lineNumber, candidates } of report.ambiguousLines) {
    warn(
      `order.txt satır ${lineNumber}: "${line}" birden fazla dosyaya uyuyor ` +
      `(${candidates.map((c) => basename(c)).join(', ')}). Satır atlandı.`,
    );
  }
  if (report.unlistedFiles.length > 0) {
    warn(
      `order.txt'de geçmeyen ${report.unlistedFiles.length} dosya sona eklendi: ` +
      `${report.unlistedFiles.map((f) => basename(f)).join(', ')}`,
    );
  }

  return {
    ordered: report.ordered,
    sortSource: 'order.txt',
    orderReport: {
      unmatchedLines: report.unmatchedLines,
      ambiguousLines: report.ambiguousLines,
      unlistedFiles: report.unlistedFiles,
    },
  };
}

/**
 * Kopyalanacak mı encode edilecek mi, hangi yöntemle birleştirilecek.
 *
 * concat demuxer tüm girdilerin aynı parametrelerde olmasını şart koşar, bu
 * yüzden karar dosya başına değil TOPLU verilir: tek dosya bile uymuyorsa
 * hepsi encode edilir.
 *
 * @param {Array<{ audioCodec: string|null, sampleRate: number|null, channels: number|null }>} probes
 * @param {{ sampleRate: number, channels: number }} target
 */
function decideCodec(probes, target) {
  const signature = (p) => `${p.audioCodec}/${p.sampleRate}/${p.channels}`;
  const uniform = probes.every((p) => signature(p) === signature(probes[0]));

  if (!uniform) {
    const kinds = [...new Set(probes.map(signature))].join(', ');
    return {
      action: 'encode',
      method: 'filter',
      reason: `girdiler tek biçimli değil (${kinds}); concat filtresi yeniden örnekleme yapar`,
    };
  }

  const [first] = probes;
  const matchesWhitelist =
    first.audioCodec === COPY_WHITELIST.codec &&
    first.sampleRate === target.sampleRate &&
    first.channels === target.channels;

  if (matchesWhitelist) {
    return {
      action: 'copy',
      method: 'demuxer',
      reason: `${probes.length}/${probes.length} girdi beyaz listeye uyuyor (${signature(first)})`,
    };
  }

  return {
    action: 'encode',
    method: 'demuxer',
    reason: `girdiler beyaz liste dışı (${signature(first)}), hedef ` +
      `${COPY_WHITELIST.codec}/${target.sampleRate}/${target.channels}`,
  };
}

/**
 * concat demuxer yolu: list.txt + tek geçiş.
 *
 * Her dosyayı ayrı ayrı AAC'ye çevirip sonra `-c copy` ile eklemek, her
 * birleşme noktasında encoder priming boşluğu bırakır. Tek geçiş referans
 * çıktının üretildiği yöntemdir.
 */
async function buildDemuxerArgs(paths, workspace, outputPath, decision, format) {
  const listContent = paths.map(concatLine).join('\n') + '\n';
  const listPath = await workspace.writeText('list.txt', listContent);

  return [
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-vn',
    ...encodeArgs(decision.action, format),
    '-y', outputPath,
  ];
}

/**
 * concat filtresi yolu: karışık sample rate / kanal sayısında demuxer
 * yeniden örnekleme yapmaz ve pitch kayması üretir; filtre yapar.
 */
function buildFilterArgs(paths, outputPath, format) {
  const inputs = paths.flatMap((path) => ['-i', path]);
  const streams = paths.map((_, i) => `[${i}:a]`).join('');

  return [
    ...inputs,
    '-filter_complex', `${streams}concat=n=${paths.length}:v=0:a=1[out]`,
    '-map', '[out]',
    ...encodeArgs('encode', format),
    '-y', outputPath,
  ];
}

/**
 * @param {'copy'|'encode'} action
 * @param {{ bitrate: string, sampleRate: number, channels: number }} format
 */
function encodeArgs(action, format) {
  if (action === 'copy') return ['-c:a', 'copy'];
  return [
    '-c:a', 'aac',
    '-b:a', format.bitrate,
    '-ar', String(format.sampleRate),
    '-ac', String(format.channels),
  ];
}
