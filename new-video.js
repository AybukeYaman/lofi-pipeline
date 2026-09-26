#!/usr/bin/env node
/**
 * Aşama 7a — yeni video projesi.
 *
 *   node new-video.js "<isim>" [--style <ad>] [--ambient <ad>] [--video-source clip|image]
 *                     [--videos-dir <yol>] [--ambient-dir <yol>]
 *
 * videolar/<isim>/ altına audio/, resimler/, videolar/ + project.json (clip
 * boş), prompts.md (kamera açısı promptları). Stil isteğe bağlı bir müzik
 * profilidir; görseller elle üretilir. Önce her şey doğrulanır, sonra
 * yazılır; klasör zaten varsa hiçbir şeye dokunulmaz.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { VIDEO_SOURCES } from './core/config.js';
import { AmbientError, DEFAULT_AMBIENT_DIR, findAmbient, listAmbients } from './prep/ambients.js';
import { PromptError, loadTemplates } from './prep/prompts.js';
import {
  DEFAULT_VIDEOS_DIR, ProjectExistsError, planProjectAsync, validateVideoName, writeProject,
} from './prep/scaffold.js';
import { STYLES_DIR, StyleError, loadStyle } from './prep/styles.js';

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
 *   styleName?: string,
 *   ambientName?: string|string[],
 *   videoSource?: 'clip'|'image',
 *   videosDir?: string,
 *   ambientDir?: string,
 *   stylesDir?: string,
 *   promptsDir?: string,
 *   concept?: string,
 *   totalTracks?: number,
 * }} input styleName: müzik stili, isteğe bağlı
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
  styleName,
  ambientName,
  videoSource = 'clip',
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  stylesDir = STYLES_DIR,
  promptsDir,
  concept,
  totalTracks,
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

  let style = null;
  if (styleName !== undefined) {
    try {
      const loaded = await loadStyle(styleName, { dir: stylesDir, ambients: ambients ?? undefined });
      style = loaded.style;
      warnings.push(...loaded.warnings);
    } catch (error) {
      if (!(error instanceof StyleError)) throw error;
      problems.push(...error.problems.map((p) => `stil "${styleName}": ${p}`));
    }
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

  let templates = null;
  try {
    templates = await loadTemplates({ dir: promptsDir });
  } catch (error) {
    if (!(error instanceof PromptError)) throw error;
    problems.push(...error.problems);
  }

  if (problems.length > 0) throw new NewVideoError(problems);

  let plan;
  try {
    plan = await planProjectAsync({ videosDir, videoName, style, ambient, templates, concept, totalTracks, videoSource });
  } catch (error) {
    if (!(error instanceof PromptError)) throw error;
    throw new NewVideoError(error.problems);
  }
  await writeProject(plan);

  const suggested = style?.suggestedAmbient;
  return {
    dir: plan.dir,
    files: plan.files.map((f) => f.path),
    warnings,
    ambient,
    suggestion: ambient || !suggested ? null : {
      name: suggested,
      ambient: ambients ? findAmbient(ambients, suggested) : null,
    },
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Kullanım:
  node new-video.js "<isim>" [--style <ad>] [--ambient <ad>] [--video-source clip|image]
                    [--concept <metin>] [--total-tracks <sayı>]

  <isim>               videolar klasöründe açılacak proje (boşluk varsa tırnak içinde)
  --style <ad>         styles/ içindeki müzik stili — verilmezse varsayılan lofi profili
  --ambient <ad>       ortak ses efekti (ör. heavyRain) — verilmezse project.json'da ambient olmaz
  --video-source <tür> clip: döngü video (.mp4, varsayılan) · image: tüm video boyunca tek resim
  --concept <metin>    albüm konsepti (ör. "2:17 AM — Everyone Is Asleep")
  --total-tracks <n>   üretilecek müzik parça sayısı (varsayılan: 17)
  --videos-dir <yol>   videolar kökü (varsayılan: ${DEFAULT_VIDEOS_DIR})
  --ambient-dir <yol>  ambient klasörü (varsayılan: ${DEFAULT_AMBIENT_DIR})
  --styles-dir <yol>   stil klasörü (varsayılan: repodaki styles/)
  -h, --help           bu metin`;

/** @param {string[]} argv */
export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      style: { type: 'string' },
      ambient: { type: 'string' },
      'video-source': { type: 'string' },
      concept: { type: 'string' },
      'total-tracks': { type: 'string' },
      'videos-dir': { type: 'string' },
      'ambient-dir': { type: 'string' },
      'styles-dir': { type: 'string' },
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
    styleName: values.style,
    ambientName: values.ambient,
    videoSource: values['video-source'],
    concept: values.concept,
    totalTracks: values['total-tracks'] ? parseInt(values['total-tracks'], 10) : undefined,
    videosDir: values['videos-dir'],
    ambientDir: values['ambient-dir'],
    stylesDir: values['styles-dir'],
  };
}

/** @param {Awaited<ReturnType<typeof runNewVideo>>} result */
function describeResult(result) {
  const lines = [
    `Proje oluşturuldu: ${result.dir}`,
    '  audio\\  resimler\\  videolar\\',
    '  project.json · prompts.md',
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
    '  1. Master görselini resimler\\MASTER.png olarak koy (açı promptları: prompts.md)',
    '  2. Klibi videolar\\ altına koy (tek resim modunda gerekmez)',
    '  3. Suno parçalarını audio\\ altına koy',
    `  4. node build.js --project "${resolve(result.dir, 'project.json')}"`,
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
      styleName: cli.styleName,
      ambientName: cli.ambientName,
      videoSource: cli.videoSource,
      concept: cli.concept,
      totalTracks: cli.totalTracks,
      videosDir: cli.videosDir,
      ambientDir: cli.ambientDir,
      stylesDir: cli.stylesDir,
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
