#!/usr/bin/env node
/**
 * Aşama 8 — üretim paneli.
 *
 *   npm start        (= node lofi.js)
 *
 * Numaralı menü: adımlar tek tek çalıştırılır ya da "Projeye devam et" ile
 * proje klasörüne bakılıp kaldığı yerden sürdürülür. Komutlar (new-video,
 * add-style, build) ayrı süreçte çalışır ve terminali devralır.
 */

import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_AMBIENT_DIR } from './prep/ambients.js';
import { inspectProject, nextStep } from './prep/project-status.js';
import { DEFAULT_VIDEOS_DIR } from './prep/scaffold.js';
import { STYLES_DIR } from './prep/styles.js';
import {
  addStyle, batchBuild, buildProject, chooseClip, continueProject, createSession, newProject,
  selectProject, showLibrary, showStatus,
} from './ui/actions.js';
import { PromptClosedError, createPrompter } from './ui/prompt.js';
import { runScript } from './ui/runner.js';

/** Proje isteyen akış: seçili proje yoksa önce seçtirir. */
const withProject = (flow) => async (ctx) => {
  const dir = await selectProject(ctx);
  if (dir) await flow(ctx, dir);
};

const MENU = [
  { label: 'Projeye devam et (kaldığı yerden)', run: continueProject },
  { label: 'Yeni proje oluştur', run: newProject },
  { label: 'Stil ekle (görselden, Gemini)', run: addStyle },
  { label: 'Klibi seç (project.json → clip)', run: withProject(chooseClip) },
  { label: 'Montaj (build)', run: withProject(buildProject) },
  { label: 'Toplu montaj (birden fazla proje)', run: batchBuild },
  { label: 'Proje durumu', run: withProject(showStatus) },
  { label: "Stiller ve ambient'ler", run: showLibrary },
  { label: 'Başka proje seç', run: (ctx) => selectProject(ctx, { force: true }) },
];

/**
 * Menü döngüsü. Akış hatası paneli düşürmez; giriş kapanınca (EOF, menüde
 * Ctrl+C) 0 döner.
 *
 * @param {object} ctx { prompter, run, videosDir, ambientDir, stylesDir, session }
 * @param {{ menu?: typeof MENU }} [options]
 * @returns {Promise<number>}
 */
export async function runPanel(ctx, { menu = MENU } = {}) {
  const { prompter } = ctx;
  for (;;) {
    try {
      const entry = await prompter.choose(
        await header(ctx),
        menu.map((item) => ({ label: item.label, value: item })),
        { zeroLabel: 'Çık' },
      );
      if (!entry) return 0;
      await entry.run(ctx);
    } catch (error) {
      if (error instanceof PromptClosedError) {
        prompter.print('\nÇıkılıyor.');
        return 0;
      }
      prompter.print(`\nHata: ${error.message}`);
    }
  }
}

async function header(ctx) {
  const lines = ['', 'lofi — üretim paneli'];
  const dir = ctx.session.project;
  if (dir) {
    const status = await inspectProject(dir);
    const skipped = ctx.session.skipped.get(dir);
    lines.push(`Proje: ${basename(dir)} — sıradaki: ${nextStep(status, { skipped }).title}`);
  }
  return lines.join('\n');
}

/** @returns {Promise<number>} 0 · 2 terminal etkileşimli değil */
export async function main() {
  // enquirer TTY olmayan stdin'de yakalanamayan hatayla süreci çökertir: önce denetle.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Panel etkileşimli terminal gerektirir — PowerShell\'de "npm start" ile çalıştır.');
    return 2;
  }

  // enquirer okuyucuyu her soruda açıp kapatır; komut çalışırken açık prompt yok.
  return runPanel({
    prompter: createPrompter(),
    run: runScript,
    videosDir: DEFAULT_VIDEOS_DIR,
    ambientDir: DEFAULT_AMBIENT_DIR,
    stylesDir: STYLES_DIR,
    session: createSession(),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
