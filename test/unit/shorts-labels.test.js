/**
 * Shorts alt projesinde video üstü yazılar: aynı editör, 9:16 çıktı.
 *
 *   - getLabels/updateLabels Shorts için dikey kadraj ve kaynak videoyu önizleme verir;
 *   - render'a yalnızca serbest metin gider (Pomodoro yazıları Shorts'ta anlamsız);
 *   - yazı yoksa render eskisi gibi (filtre null, -vf yalnızca kırp+ölçek).
 */

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { buildShortsFilter, computeShortsCrop } from '../../core/shorts-plan.js';
import { getLabels, updateLabels } from '../../server/project-api.js';
import {
  createShortsClip,
  createShortsSubproject,
  getShorts,
  resetShortsRenders,
  startShortsRender,
} from '../../server/shorts-api.js';
import { DEFAULT_LABEL_FONT_FILE } from '../../steps/04a-label-overlay.js';
import { exportShortsClip } from '../../steps/08-shorts-export.js';

const probeFn = async () => ({ duration: 60, width: 1280, height: 720, fps: 25, hasAudio: true });

let hasFont = true;
try { await access(DEFAULT_LABEL_FONT_FILE); } catch { hasFont = false; }

async function createFixture() {
  const base = await mkdtemp(join(tmpdir(), 'lofi-shorts-labels-'));
  const videosDir = join(base, 'videolar');
  const parentDir = join(videosDir, 'Ana Proje');
  await mkdir(join(parentDir, 'videolar'), { recursive: true });
  await writeFile(join(parentDir, 'videolar', 'kaynak.mp4'), 'video-bytes');
  await writeFile(join(parentDir, 'project.json'), JSON.stringify({
    clip: './videolar/kaynak.mp4', audioDir: './audio', output: { dir: './out' },
  }, null, 2));
  return { videosDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** Render bitene kadar bekler. */
async function waitForRender(id, options) {
  let state = null;
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = await getShorts(id, options);
    if (state.renders[0]?.state !== 'running') break;
  }
  return state;
}

describe('Shorts: etiket editörü verisi', () => {
  test('dikey 9:16 kadraj, kaynak video önizleme, Pomodoro kapalı', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const res = await getLabels(created.id, { videosDir: fx.videosDir });
      assert.equal(res.aspect, '9:16');
      assert.equal(res.preview.kind, 'video');
      assert.equal(res.preview.url, `/api/projects/${encodeURIComponent(created.id)}/shorts/source`);
      assert.equal(res.pomodoro.enabled, false);
    } finally {
      await fx.cleanup();
    }
  });

  test('Shorts projesinde Pomodoro ayarı olsa bile Pomodoro etiketi sunulmaz', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const path = join(fx.videosDir, created.id, 'project.json');
      const json = JSON.parse(await readFile(path, 'utf8'));
      json.pomodoro = { enabled: true, preset: '50/10', rounds: 4 };
      await writeFile(path, JSON.stringify(json));
      const res = await getLabels(created.id, { videosDir: fx.videosDir });
      assert.equal(res.pomodoro.enabled, false);
      assert.deepEqual(res.pomodoro.sessions, []);
    } finally {
      await fx.cleanup();
    }
  });

  test('yazılar Shorts alt projesinin project.json\'una yazılır, ana projeye dokunmaz', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const parentBefore = await readFile(join(fx.videosDir, 'Ana Proje', 'project.json'), 'utf8');
      await updateLabels(created.id, { labels: [{ id: 'a', text: 'Selam', x: 0.5, y: 0.2 }] }, { videosDir: fx.videosDir });

      const json = JSON.parse(await readFile(join(fx.videosDir, created.id, 'project.json'), 'utf8'));
      assert.equal(json.labels[0].text, 'Selam');
      assert.equal(await readFile(join(fx.videosDir, 'Ana Proje', 'project.json'), 'utf8'), parentBefore);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('Shorts: render yazıları taşır', () => {
  const labelsFor = (...extra) => [{ id: 'a', text: 'Selam', x: 0.5, y: 0.2 }, ...extra];

  async function renderWith(labels) {
    const fx = await createFixture();
    resetShortsRenders();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      if (labels) await updateLabels(created.id, { labels }, options);
      const added = await createShortsClip(created.id, { start: 2, end: 9 }, options);

      const calls = [];
      const exportFn = async (input) => {
        calls.push(input);
        await mkdir(join(fx.videosDir, created.id, 'out', 'shorts'), { recursive: true });
        await writeFile(input.outputPath, 'rendered');
      };
      await startShortsRender(created.id, added.clips[0].id, { ...options, exportFn });
      const state = await waitForRender(created.id, options);
      return { calls, state };
    } finally {
      resetShortsRenders();
      await fx.cleanup();
    }
  }

  test('yazı yoksa labelFilter null: render eskisi gibi', async () => {
    const { calls, state } = await renderWith(null);
    assert.equal(calls[0].labelFilter, null);
    assert.equal(state.renders[0].state, 'succeeded', state.renders[0].error ?? undefined);
  });

  test('serbest metin drawtext olarak render\'a gider; Pomodoro yazıları gitmez', { skip: !hasFont }, async () => {
    const { calls, state } = await renderWith(labelsFor(
      { id: 's', kind: 'pomodoro-status', x: 0.8, y: 0.1 },
      { id: 'c', kind: 'pomodoro-countdown', x: 0.8, y: 0.05 },
    ));
    assert.equal(state.renders[0].state, 'succeeded', state.renders[0].error ?? undefined);
    const filter = calls[0].labelFilter;
    assert.equal(filter.split('drawtext=').length - 1, 1, 'yalnızca serbest metin');
    // Konum 1080×1920'nin oranı: yükseklik 1920 üzerinden yazı boyutu 0.05*1920 = 96 px.
    assert.match(filter, /fontsize=96/);
    assert.match(filter, /h\*0\.2-text_h\/2/);
  });

  test('yalnızca Pomodoro yazısı varsa Shorts render\'ı yazısız çıkar (hata vermez)', async () => {
    const { calls, state } = await renderWith([{ id: 's', kind: 'pomodoro-status' }]);
    assert.equal(calls[0].labelFilter, null);
    assert.equal(state.renders[0].state, 'succeeded');
  });
});

describe('08 — exportShortsClip -vf zinciri', () => {
  const sourceInfo = { width: 1280, height: 720, hasAudio: true };
  const clip = { start: 2, end: 9, frame: { zoom: 1, x: 0.5, y: 0.5 } };

  async function vfOf(extra) {
    const calls = [];
    const base = await mkdtemp(join(tmpdir(), 'lofi-08-'));
    try {
      await exportShortsClip({
        sourcePath: 'kaynak.mp4', clip, outputPath: join(base, 'out', 'a.mp4'), sourceInfo,
        ffmpegFn: async (args) => { calls.push(args); },
        ...extra,
      });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
    const args = calls[0];
    return args[args.indexOf('-vf') + 1];
  }

  test('etiket filtresi yoksa zincir eskisiyle birebir aynı', async () => {
    const crop = computeShortsCrop({ sourceWidth: 1280, sourceHeight: 720 });
    assert.equal(await vfOf({}), buildShortsFilter(crop));
    assert.equal(await vfOf({ labelFilter: null }), buildShortsFilter(crop));
  });

  test('etiket filtresi kırp+ölçekten SONRA eklenir (konum 1080×1920 kadrajına göre)', async () => {
    const crop = computeShortsCrop({ sourceWidth: 1280, sourceHeight: 720 });
    const vf = await vfOf({ labelFilter: "drawtext=text='x'" });
    assert.equal(vf, `${buildShortsFilter(crop)},drawtext=text='x'`);
  });
});
