#!/usr/bin/env node
/**
 * Aşama 7a — yeni video projesi.
 *
 *   node new-video.js "<isim>" --style <ad> [--ambient <ad>]
 *                     [--videos-dir <yol>] [--ambient-dir <yol>]
 *
 * videolar/<isim>/ altına audio/, resimler/, videolar/ + STYLE_BLOCK.txt,
 * project.json (clip boş), prompts.md; stilin referans görseli varsa
 * resimler/style-ref.<uzantı>. Önce her şey doğrulanır, sonra yazılır;
 * klasör zaten varsa hiçbir şeye dokunulmaz.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { AmbientError, DEFAULT_AMBIENT_DIR, findAmbient, listAmbients } from './prep/ambients.js';
import { PromptError, loadTemplates } from './prep/prompts.js';
import {
  DEFAULT_VIDEOS_DIR, ProjectExistsError, planProject, validateVideoName, writeProject,
} from './prep/scaffold.js';
import { STYLES_DIR, StyleError, findStyleRef, listStyles, loadStyle } from './prep/styles.js';

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
 *   styleName: string,
 *   ambientName?: string,
 *   videosDir?: string,
 *   ambientDir?: string,
 *   stylesDir?: string,
 *   promptsDir?: string,
 * }} input
 * @returns {Promise<{
 *   dir: string,
 *   files: string[],
 *   copies: string[],
 *   warnings: string[],
 *   ambient: { name: string, path: string } | null,
 *   suggestion: { name: string, ambient: { name: string, path: string } | null } | null,
 * }>} suggestion: ambient seçilmediyse stilin önerisi
 */
export async function runNewVideo({
  videoName,
  styleName,
  ambientName,
  videosDir = DEFAULT_VIDEOS_DIR,
  ambientDir = DEFAULT_AMBIENT_DIR,
  stylesDir = STYLES_DIR,
  promptsDir,
}) {
  const problems = validateVideoName(videoName);
  const warnings = [];

  let ambients = null;
  try {
    ambients = await listAmbients(ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
    // Ambient opsiyonel: istenmediyse klasörün okunamaması projeyi durdurmaz.
    if (ambientName !== undefined) problems.push(error.message);
    else warnings.push(`${error.message} — önerilen ambient denetlenmedi`);
  }

  let style = null;
  try {
    const loaded = await loadStyle(styleName, { dir: stylesDir, ambients: ambients ?? undefined });
    style = loaded.style;
    warnings.push(...loaded.warnings);
  } catch (error) {
    if (!(error instanceof StyleError)) throw error;
    problems.push(...error.problems.map((p) => `stil "${styleName}": ${p}`));
  }

  let ambient = null;
  if (ambientName !== undefined && ambients) {
    ambient = findAmbient(ambients, ambientName);
    if (!ambient) {
      problems.push(`bilinmeyen ambient "${ambientName}" — mevcut: ${ambients.map((a) => a.name).join(', ') || '(yok)'}`);
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

  const ref = await findStyleRef(styleName, { dir: stylesDir });
  warnings.push(...ref.warnings);

  let plan;
  try {
    plan = planProject({ videosDir, videoName, style, ambient, styleRef: ref.path, templates });
  } catch (error) {
    if (!(error instanceof PromptError)) throw error;
    throw new NewVideoError(error.problems);
  }
  await writeProject(plan);

  return {
    dir: plan.dir,
    files: plan.files.map((f) => f.path),
    copies: plan.copies.map((c) => c.path),
    warnings,
    ambient,
    suggestion: ambient ? null : {
      name: style.suggestedAmbient,
      ambient: ambients ? findAmbient(ambients, style.suggestedAmbient) : null,
    },
  };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Kullanım:
  node new-video.js "<isim>" --style <ad> [--ambient <ad>]

  <isim>               videolar klasöründe açılacak proje (boşluk varsa tırnak içinde)
  --style <ad>         styles/ içindeki stil — verilmezse mevcut stiller listelenir
  --ambient <ad>       ortak ses efekti (ör. heavyRain) — verilmezse project.json'da ambient olmaz
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
    videosDir: values['videos-dir'],
    ambientDir: values['ambient-dir'],
    stylesDir: values['styles-dir'],
  };
}

/** --style verilmediğinde basılan kütüphane özeti. */
async function describeLibrary({ ambientDir, stylesDir = STYLES_DIR }) {
  const lines = ['Stil seçilmedi (--style). Mevcut stiller:'];

  let ambients;
  try {
    ambients = await listAmbients(ambientDir);
  } catch (error) {
    if (!(error instanceof AmbientError)) throw error;
  }

  const names = await listStyles({ dir: stylesDir });
  const width = Math.max(0, ...names.map((n) => n.length));
  for (const name of names) {
    const ref = (await findStyleRef(name, { dir: stylesDir })).path ? 'referans görseli var' : 'referans görseli yok';
    try {
      const { style } = await loadStyle(name, { dir: stylesDir, ambients });
      lines.push(`  ${name.padEnd(width)}  öneri: --ambient ${style.suggestedAmbient} · ${ref}`);
    } catch (error) {
      if (!(error instanceof StyleError)) throw error;
      lines.push(`  ${name.padEnd(width)}  (geçersiz — ${error.problems.length} problem)`);
    }
  }
  if (names.length === 0) lines.push('  (yok)');

  lines.push('', ambients
    ? `Ambient'ler: ${ambients.map((a) => a.name).join(', ') || '(yok)'}`
    : `Ambient klasörü okunamadı: ${ambientDir ?? DEFAULT_AMBIENT_DIR}`);
  lines.push('', 'Örnek: node new-video.js "video3-Neo Tokyo Night" --style cozy-realistic --ambient heavyRain');
  return lines.join('\n');
}

/** @param {Awaited<ReturnType<typeof runNewVideo>>} result */
function describeResult(result) {
  const lines = [
    `Proje oluşturuldu: ${result.dir}`,
    '  audio\\  resimler\\  videolar\\',
    `  ${['STYLE_BLOCK.txt', 'project.json', 'prompts.md'].join(' · ')}` +
      (result.copies.length > 0 ? ' · resimler\\style-ref' : ''),
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
  if (result.copies.length === 0) {
    lines.push('', 'Stilin referans görseli yok — Faz 1\'de Image 2 olarak stil görselini elle ekle.');
  }

  lines.push(
    '',
    'Sıradaki adımlar:',
    '  1. prompts.md → Faz 1–3 (görseller resimler\\, klip videolar\\ altına)',
    '  2. Suno parçalarını audio\\ altına koy',
    '  3. project.json → "clip" alanına klibin yolunu yaz (ör. ./videolar/in.mp4)',
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
  if (cli.styleName === undefined) {
    console.error(await describeLibrary({ ambientDir: cli.ambientDir, stylesDir: cli.stylesDir }));
    return 2;
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
