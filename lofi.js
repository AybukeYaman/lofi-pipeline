#!/usr/bin/env node
/**
 * Aşama 8 — üretim paneli.
 *
 *   npm start        (= node lofi.js)
 *
 * Numaralı menü: adımlar tek tek çalıştırılır ya da "Projeye devam et" ile
 * proje klasörüne bakılıp kaldığı yerden sürdürülür. Komutlar (new-video,
 * build) ayrı süreçte çalışır ve terminali devralır.
 */

import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { render } from 'ink';

import { DEFAULT_AMBIENT_DIR } from './prep/ambients.js';
import { inspectProject, listProjects, nextStep } from './prep/project-status.js';
import { DEFAULT_VIDEOS_DIR } from './prep/scaffold.js';
import { STYLES_DIR } from './prep/styles.js';
import {
  batchBuild, buildProject, chooseClip, continueProject, createSession, newProject,
  selectProject, showLibrary, showStatus,
} from './ui/actions.js';
import { createInkPrompter } from './ui/ink-prompter.js';
import { PromptClosedError, createPrompter } from './ui/prompt.js';
import { isParentAlive, runScript } from './ui/runner.js';
import { DashboardView } from './ui/tui/dashboard-view.js';
import { h } from './ui/tui/h.js';
import { Screen } from './ui/tui/screen.js';
import { createTuiStore } from './ui/tui/store.js';

/** Ctrl+C'den sonra panelin kendi yolundan çıkması için tanınan süre. */
const CLOSE_GRACE_MS = 500;

/** Proje isteyen akış: seçili proje yoksa önce seçtirir. */
const withProject = (flow) => async (ctx) => {
  const dir = await selectProject(ctx);
  if (dir) await flow(ctx, dir);
};

const MENU = [
  { label: 'Create new video', run: newProject },
  { label: 'Continue existing project', run: continueProject },
  { label: 'Projects', run: withProject(showStatus) },
  { label: 'Settings', run: showLibrary },
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
      if (ctx.store) {
        ctx.store.set({ view: 'main' });
        try {
          const projects = await listProjects(ctx.videosDir);
          ctx.store.set({ projectsList: projects });
        } catch {}
        if (ctx.session.project) {
          try {
            const status = await inspectProject(ctx.session.project);
            const skipped = ctx.session.skipped.get(ctx.session.project);
            const step = nextStep(status, { skipped });
            ctx.store.set({
              activeProject: {
                name: basename(ctx.session.project),
                dir: ctx.session.project,
                step: step.title,
              },
            });
          } catch {}
        } else {
          ctx.store.set({ activeProject: null });
        }
      }
      const entry = await prompter.choose(
        await header(ctx),
        menu.map((item) => ({ label: item.label, value: item })),
        { zeroLabel: 'Quit' },
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
  return 'lofi — üretim paneli';
}

/** @returns {Promise<number>} 0 · 2 terminal etkileşimli değil */
export async function main() {
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process');
      execSync('chcp 65001', { stdio: 'ignore' });
    } catch {}
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Panel etkileşimli terminal gerektirir — PowerShell\'de "npm start" ile çalıştır.');
    return 2;
  }

  const store = createTuiStore({
    header: { title: 'lofi CLI', step: 'Ana Menü' },
    view: 'main',
  });

  const prompter = createInkPrompter(store);
  const session = createSession();

  let inkApp = null;
  const mountInk = () => {
    if (!inkApp) {
      // exitOnCtrlC kapalı: açıkken ink Ctrl+C'yi useInput'a iletmeden kendini söküyor,
      // store.close() hiç çağrılmıyor ve panel süreci ekransız asılı kalabiliyordu.
      inkApp = render(h(Screen, { store, body: (snap, size) => h(DashboardView, { snap, size }) }), { exitOnCtrlC: false });
    }
  };
  const unmountInk = () => {
    if (inkApp) {
      inkApp.unmount();
      inkApp = null;
    }
  };

  // Ctrl+C: bekleyen soru varsa runPanel normal yoldan çıkar. Soru yokken bir iş
  // sürüyorsa (Gemini, Suno indirme) onu beklemeden kapat. unref: normal çıkışı geciktirmez.
  let closing = false;
  store.subscribe(() => {
    if (closing || !store.getState().closed) return;
    closing = true;
    setTimeout(() => {
      unmountInk();
      process.exit(130);
    }, CLOSE_GRACE_MS).unref();
  });

  mountInk();

  const ctx = {
    prompter,
    run: async (script, args, opts) => {
      unmountInk();
      const code = await runScript(script, args, opts);
      if (!isParentAlive()) process.exit(code);
      mountInk();
      return code;
    },
    videosDir: DEFAULT_VIDEOS_DIR,
    ambientDir: DEFAULT_AMBIENT_DIR,
    stylesDir: STYLES_DIR,
    session,
    store,
  };

  try {
    const exitCode = await runPanel(ctx);
    unmountInk();
    return exitCode;
  } catch (error) {
    unmountInk();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await main();
  process.exit(code ?? 0);
}

