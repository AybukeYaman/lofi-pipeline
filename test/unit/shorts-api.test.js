import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { inspectProject, nextStep, projectWorkflow } from '../../prep/project-status.js';
import {
  createShortsClip,
  createShortsSubproject,
  deleteShortsClip,
  getShorts,
  getShortsClipAsset,
  getShortsSourceAsset,
  patchShortsClip,
  resetShortsRenders,
  startShortsRender,
} from '../../server/shorts-api.js';

/** Sahte ölçüm: ffprobe çağrılmadan 1280×720 / 60 sn bir kaynak. */
const probeFn = async () => ({ duration: 60, width: 1280, height: 720, fps: 25, hasAudio: true });

/**
 * Ana proje + kaynak video. Shorts alt projesi API ile açılıyor — testin
 * doğruladığı şey de bu: klasör, project.json ve kaynak YOLU (kopya değil).
 */
async function createFixture() {
  const base = await mkdtemp(join(tmpdir(), 'lofi-shorts-'));
  const videosDir = join(base, 'videolar');
  const parentDir = join(videosDir, 'Ana Proje');
  await mkdir(join(parentDir, 'videolar'), { recursive: true });
  await writeFile(join(parentDir, 'videolar', 'kaynak.mp4'), 'video-bytes');
  await writeFile(join(parentDir, 'project.json'), JSON.stringify({
    clip: './videolar/kaynak.mp4',
    audioDir: './audio',
    output: { dir: './out' },
  }, null, 2));

  return { base, videosDir, parentDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe('Shorts alt projesi', () => {
  test('ana projeden açılır: kaynak KOPYALANMAZ, göreceli yol tutulur', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      assert.equal(created.id, 'Ana Proje Shorts 01');
      assert.equal(created.kind, 'shorts');
      assert.equal(created.parentId, 'Ana Proje');
      assert.equal(created.source.name, 'kaynak.mp4');
      assert.equal(created.source.exists, true);

      const json = JSON.parse(await readFile(join(fx.videosDir, created.id, 'project.json'), 'utf8'));
      assert.equal(json.kind, 'shorts');
      assert.equal(json.parentId, 'Ana Proje');
      assert.match(json.shorts.source, /^\.\.[\\/]Ana Proje/);
      assert.equal(json.video.aspect, '9:16');
      // Kaynak dosyanın kopyası alt projeye YAZILMAMALI.
      const copied = await readFile(join(fx.videosDir, created.id, 'kaynak.mp4'), 'utf8').catch(() => null);
      assert.equal(copied, null);
    } finally {
      await fx.cleanup();
    }
  });

  test('aynı ana projeden ikinci alt proje ad çakışmadan açılır', async () => {
    const fx = await createFixture();
    try {
      await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const second = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      assert.equal(second.id, 'Ana Proje Shorts 02');
    } finally {
      await fx.cleanup();
    }
  });

  test('kaynağı olmayan projede 422, Shorts projesine Shorts açılmaz', async () => {
    const fx = await createFixture();
    try {
      const emptyDir = join(fx.videosDir, 'Bos Proje');
      await mkdir(emptyDir, { recursive: true });
      await writeFile(join(emptyDir, 'project.json'), '{"clip":"","audioDir":"./audio"}');
      await assert.rejects(
        () => createShortsSubproject('Bos Proje', {}, { videosDir: fx.videosDir }),
        /kaynak video yok/,
      );

      const shorts = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      await assert.rejects(
        () => createShortsSubproject(shorts.id, {}, { videosDir: fx.videosDir }),
        /yeniden Shorts alt projesi açılamaz/,
      );
    } finally {
      await fx.cleanup();
    }
  });

});

describe('Shorts kesitleri', () => {
  test('aralık eklenir, kadraj pikselleri hesaplanır, sıra zamana göre', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };

      await createShortsClip(created.id, { start: 30, end: 45 }, options);
      const state = await createShortsClip(
        created.id,
        { start: 4, end: 12, frame: { zoom: 1.5, x: 0, y: 0.5 } },
        options,
      );

      assert.deepEqual(state.clips.map((clip) => clip.title), ['Shorts 02', 'Shorts 01']);
      const [first] = state.clips;
      assert.equal(first.start, 4);
      assert.equal(first.durationLabel, '00:08.0');
      // 720 / 1.5 = 480 yükseklik, 480 * 9/16 = 270 genişlik, x = 0
      assert.deepEqual(first.crop, { width: 270, height: 480, x: 0, y: 120 });
      assert.equal(first.rendered, false);
      assert.equal(first.videoUrl, null);
    } finally {
      await fx.cleanup();
    }
  });

  test('kaynaktan uzun ya da çok kısa aralık 422', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      await assert.rejects(() => createShortsClip(created.id, { start: 50, end: 90 }, options), /kaynak videodan uzun/);
      await assert.rejects(() => createShortsClip(created.id, { start: 5, end: 5.2 }, options), /en az 1 sn/);
    } finally {
      await fx.cleanup();
    }
  });

  test('güncelleme aralığı değiştirince render damgası düşer', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      const added = await createShortsClip(created.id, { start: 10, end: 20 }, options);
      const clipId = added.clips[0].id;

      // Render damgasını elle yaz (render edilmiş gibi).
      const projectPath = join(fx.videosDir, created.id, 'project.json');
      const json = JSON.parse(await readFile(projectPath, 'utf8'));
      json.shorts.clips[0].renderedAt = '2026-10-07T10:00:00.000Z';
      await writeFile(projectPath, JSON.stringify(json, null, 2));

      const sameFrame = await patchShortsClip(created.id, clipId, { title: 'Giriş' }, options);
      assert.equal(sameFrame.clips[0].title, 'Giriş');
      assert.equal(sameFrame.clips[0].renderedAt, '2026-10-07T10:00:00.000Z');

      const moved = await patchShortsClip(created.id, clipId, { start: 12, end: 22 }, options);
      assert.equal(moved.clips[0].renderedAt, null);
      // Çıktı adı değişmez: diskteki dosya ile kayıt ayrı düşmesin.
      assert.equal(moved.clips[0].output, sameFrame.clips[0].output);
    } finally {
      await fx.cleanup();
    }
  });

  test('silme kaydı ve render edilmiş dosyayı Geri Dönüşüm Kutusu\'na yollar', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      const added = await createShortsClip(created.id, { start: 1, end: 6 }, options);
      const clip = added.clips[0];

      await mkdir(join(fx.videosDir, created.id, 'out', 'shorts'), { recursive: true });
      await writeFile(clip.outputPath, 'rendered');

      const trashed = [];
      const after = await deleteShortsClip(created.id, clip.id, {
        ...options,
        trashFn: async (path) => { trashed.push(path); await rm(path, { force: true }); },
      });
      assert.deepEqual(after.clips, []);
      assert.deepEqual(trashed, [clip.outputPath]);

      await assert.rejects(() => deleteShortsClip(created.id, clip.id, options), /Kesit bulunamadı/);
    } finally {
      await fx.cleanup();
    }
  });
});

describe('Shorts render', () => {
  test('render işi arka planda çalışır, bitince damga yazılır', async () => {
    const fx = await createFixture();
    resetShortsRenders();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      const added = await createShortsClip(created.id, { start: 2, end: 9 }, options);
      const clip = added.clips[0];

      const calls = [];
      const exportFn = async (input) => {
        calls.push(input);
        await mkdir(join(fx.videosDir, created.id, 'out', 'shorts'), { recursive: true });
        await writeFile(input.outputPath, 'rendered');
        return { outputPath: input.outputPath };
      };

      const job = await startShortsRender(created.id, clip.id, { ...options, exportFn });
      assert.equal(job.state, 'running');

      // İş bitene kadar bekle (arka plan görevi).
      let state = null;
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state = await getShorts(created.id, options);
        if (state.renders[0].state !== 'running') break;
      }
      assert.equal(state.renders[0].state, 'succeeded');
      assert.equal(state.clips[0].rendered, true);
      assert.ok(state.clips[0].renderedAt);
      assert.equal(state.clips[0].videoUrl.endsWith('/video'), true);

      // Render'a giden kesit: aralık + kadraj; kaynak ana projedeki dosya.
      assert.equal(calls[0].clip.start, 2);
      assert.match(calls[0].sourcePath, /Ana Proje[\\/]videolar[\\/]kaynak\.mp4$/);

      const asset = await getShortsClipAsset(created.id, clip.id, options);
      assert.equal(asset.contentType, 'video/mp4');
    } finally {
      resetShortsRenders();
      await fx.cleanup();
    }
  });

  test('render sürerken ikinci render 409', async () => {
    const fx = await createFixture();
    resetShortsRenders();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const options = { videosDir: fx.videosDir, probeFn };
      const added = await createShortsClip(created.id, { start: 2, end: 9 }, options);
      const second = await createShortsClip(created.id, { start: 20, end: 30 }, options);

      let release = () => {};
      const blocked = new Promise((resolve) => { release = resolve; });
      const exportFn = async () => { await blocked; };

      await startShortsRender(created.id, added.clips[0].id, { ...options, exportFn });
      await assert.rejects(
        () => startShortsRender(created.id, second.clips.at(-1).id, { ...options, exportFn }),
        /Zaten bir Shorts render çalışıyor/,
      );
      release();
    } finally {
      resetShortsRenders();
      await fx.cleanup();
    }
  });

  test('kaynak akışı MIME ile döner; normal proje shorts API\'sini kullanamaz', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const asset = await getShortsSourceAsset(created.id, { videosDir: fx.videosDir });
      assert.equal(asset.contentType, 'video/mp4');
      assert.ok(asset.size > 0);

      await assert.rejects(
        () => getShorts('Ana Proje', { videosDir: fx.videosDir, probeFn }),
        /bir Shorts alt projesi değil/,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

describe('Shorts proje durumu', () => {
  test('akış 3 adım: kaynak → kesitler → render', async () => {
    const fx = await createFixture();
    try {
      const created = await createShortsSubproject('Ana Proje', {}, { videosDir: fx.videosDir });
      const dir = join(fx.videosDir, created.id);

      let status = await inspectProject(dir);
      assert.equal(status.kind, 'shorts');
      assert.deepEqual(projectWorkflow(status).steps.map((step) => step.id), ['source', 'clips', 'export']);
      assert.equal(projectWorkflow(status).current, 'clips');
      assert.equal(nextStep(status).title, 'Shorts kesiti seç');

      await createShortsClip(created.id, { start: 1, end: 6 }, { videosDir: fx.videosDir, probeFn });
      status = await inspectProject(dir);
      assert.equal(projectWorkflow(status).current, 'export');
      assert.equal(nextStep(status).id, 'shorts-export');

      await mkdir(join(dir, 'out', 'shorts'), { recursive: true });
      await writeFile(status.shorts.clips[0].outputPath, 'rendered');
      status = await inspectProject(dir);
      assert.equal(projectWorkflow(status).current, 'export');
      assert.equal(projectWorkflow(status).steps.at(-1).status, 'current');
      assert.equal(nextStep(status).kind, 'done');
    } finally {
      await fx.cleanup();
    }
  });
});
