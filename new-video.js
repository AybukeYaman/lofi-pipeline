#!/usr/bin/env node
/**
 * Aşama 7a — yeni video projesi.
 *
 *   node new-video.js "<isim>" [--ambient <ad>] [--video-source clip|image]
 *                     [--videos-dir <yol>] [--ambient-dir <yol>]
 *
 * videolar/<isim>/ altına audio/, resimler/, videolar/ + project.json (clip
 * boş). Stil isteğe bağlı bir müzik profilidir; görseller elle üretilir.
 * Önce her şey doğrulanır, sonra yazılır; klasör zaten varsa hiçbir şeye
 * dokunulmaz.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { VIDEO_SOURCES } from './core/config.js';
import { AmbientError, DEFAULT_AMBIENT_DIR, findAmbient, listAmbients } from './prep/ambients.js';
import {
  DEFAULT_VIDEOS_DIR, ProjectExistsError, planProjectAsync, validateVideoName, writeProject,
} from './prep/scaffold.js';

export class NewVideoError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super('proje oluşturulmadı:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'NewVideoError';
    this.problems = problems;
  }
}

/**
 * Doğrular ve proje klasörünü kurar. Doğrulama hataları tek NewVideoError'da.
 *
 * @param {{
 *   videoName: string,
 *   ambientName?: string|string[],
 *   videoSource?: 'clip'|'image',
 *   videosDir?: string,
 *   ambientDir?: string,
 *   concept?: string,
 *   totalTracks?: number,
 * }} input
 * @returns {Promise<{
 *   dir: string,
 *   files: string[],
 *   warnings: string[],
 *   ambient: { name: string, path: string } | null,
 *   suggestion: { name: string, ambient: { name: string, path: string } | null } | null,
 * }>} suggestion: ambient seçilmediyse ve stil öneriyorsa stilin önerisi
 */
export async function runNewVideo({
  videoName,
  ambientName,
  videoSource = 'clip',
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  concept,
  totalTracks,
  parentId,
  aspect = '16:9',
}) {
  const problems = validateVideoName(videoName);
  const warnings = [];
  if (!VIDEO_SOURCES.includes(videoSource)) {
    problems.push(`bilinmeyen görsel kaynağı "${videoSource}" — ${VIDEO_SOURCES.join(' ya da ')}`);
  }

  let ambients = null;
  try {
    ambients = await listAmbients(ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    if (ambientName !== undefined) problems.push(error.message);
    else warnings.push(`${error.message} — önerilen ambient denetlenmedi`);
  }

  let ambient = null;
  if (ambientName !== undefined && ambients) {
    const names = Array.isArray(ambientName) ? ambientName : String(ambientName).split(',').map((s) => s.trim()).filter(Boolean);
    const foundAmbients = [];
    for (const name of names) {
      const found = findAmbient(ambients, name);
      if (!found) {
        problems.push(`bilinmeyen ambient "${name}" — mevcut: ${ambients.map((a) => a.name).join(', ') || '(yok)'}`);
      } else {
        foundAmbients.push(found);
      }
    }
    if (foundAmbients.length > 0) {
      ambient = foundAmbients.length === 1 ? foundAmbients[0] : foundAmbients;
    }
  }

  if (problems.length > 0) throw new NewVideoError(problems);

  const plan = await planProjectAsync({
    videosDir, videoName, ambient, concept, totalTracks, videoSource, parentId, aspect,
  });
  await writeProject(plan);

  return {
    dir: plan.dir,
    files: plan.files.map((f) => f.path),
    warnings,
    ambient,
    // Ambiance önerisi stil dosyasından geliyordu; stil kavramı kaldırıldı.
    suggestion: null,
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Kullanım:
  node new-video.js "<isim>" [--ambient <ad>] [--video-source clip|image]
                    [--concept <metin>] [--total-tracks <sayı>]

  <isim>               videolar klasöründe açılacak proje (boşluk varsa tırnak içinde)
  --ambient <ad>       ortak ses efekti (ör. heavyRain) — verilmezse project.json'da ambient olmaz
  --video-source <tür> clip: döngü video (.mp4, varsayılan) · image: tüm video boyunca tek resim
  --concept <metin>    albüm konsepti (ör. "2:17 AM — Everyone Is Asleep")
  --total-tracks <n>   üretilecek müzik parça sayısı (varsayılan: 17)
  --videos-dir <yol>   videolar kökü (varsayılan: ${DEFAULT_VIDEOS_DIR})
  --ambient-dir <yol>  ambient klasörü (varsayılan: ${DEFAULT_AMBIENT_DIR})
  -h, --help           bu metin`;

/** @param {string[]} argv */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      ambient: { type: 'string' },
      'video-source': { type: 'string' },
      concept: { type: 'string' },
      'total-tracks': { type: 'string' },
      'videos-dir': { type: 'string' },
      'ambient-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (positionals.length > 1) {
    throw new Error(
      `tek isim bekleniyordu, ${positionals.length} argüman geldi — ` +
      'isim boşluk içeriyorsa tırnak içinde yaz: "video3-Neo Tokyo Night"',
    );
  }

  return {
    help: values.help,
    videoName: positionals[0],
    ambientName: values.ambient,
    videoSource: values['video-source'],
    concept: values.concept,
    totalTracks: values['total-tracks'] ? parseInt(values['total-tracks'], 10) : undefined,
    videosDir: values['videos-dir'],
    ambientDir: values['ambient-dir'],
  };
}

/** @param {Awaited<ReturnType<typeof runNewVideo>>} result */
function describeResult(result) {
  const lines = [
    `Proje oluşturuldu: ${result.dir}`,
    '  audio\\  resimler\\  videolar\\',
    '  project.json',
  ];

  if (result.warnings.length > 0) {
    lines.push('', ...result.warnings.map((w) => `UYARI: ${w}`));
  }

  if (result.suggestion) {
    lines.push('', `Ambient seçilmedi — stilin önerisi: ${result.suggestion.name}.`);
    if (result.suggestion.ambient) {
      lines.push('Eklemek için project.json\'a:', `  "ambient": ${JSON.stringify(result.suggestion.ambient.path)},`);
    }
  }

  lines.push(
    '',
    'Sıradaki adımlar:',
    '  1. Klibi videolar\\ altına koy (tek resim modunda resimler\\ altına bir görsel)',
    '  2. Müzik parçalarını audio\\ altına koy',
    `  3. node build.js --project "${resolve(result.dir, 'project.json')}"`,
  );
  return lines.join('\n');
}

/**
 * CLI girişi. Çıkış kodları: 0 başarı · 1 klasör var / yazım hatası ·
 * 2 kullanım ya da doğrulama hatası.
 *
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (cli.help) {
    console.log(USAGE);
    return 0;
  }
  if (cli.videoName === undefined) {
    console.error(`proje ismi eksik\n\n${USAGE}`);
    return 2;
  }

  try {
    const result = await runNewVideo({
      videoName: cli.videoName,
      ambientName: cli.ambientName,
      videoSource: cli.videoSource,
      concept: cli.concept,
      totalTracks: cli.totalTracks,
      videosDir: cli.videosDir,
      ambientDir: cli.ambientDir,
    });
    console.log(describeResult(result));
    return 0;
  } catch (error) {
    if (error instanceof NewVideoError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof ProjectExistsError) {
      console.error(error.message);
      return 1;
    }
    console.error(`proje oluşturulamadı: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
