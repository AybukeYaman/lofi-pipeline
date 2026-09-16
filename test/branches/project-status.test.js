/**
 * Aşama 8a — inspectProject gerçek klasörde (boş dosyalar; medya ölçülmez).
 * Taze new-video projesinden montaja kadar kanıtlar tek tek eklenir.
 */

import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { runNewVideo } from '../../new-video.js';
import { setProjectClip } from '../../prep/project-file.js';
import { inspectProject, listProjects, nextStep } from '../../prep/project-status.js';
import { tempDir } from '../helpers/fixtures.js';

describe('inspectProject — taze projeden montaja', () => {
  let root;
  let dir;

  before(async () => {
    root = await tempDir('project-status');
    await mkdir(root.path('videolar'));
    await mkdir(root.path('ambient'));
    await writeFile(root.path('ambient/campfire.mp3'), '');
    ({ dir } = await runNewVideo({
      videoName: 'video3-Durum & Test',
      styleName: 'cozy-realistic',
      ambientName: 'campfire',
      videosDir: root.path('videolar'),
      ambientDir: root.path('ambient'),
    }));
  });
  after(() => root?.cleanup());

  test('taze proje: faz1, yollar ve varsayılan çıktı', async () => {
    const s = await inspectProject(dir);
    assert.equal(s.projectJson.ok, true);
    assert.equal(s.master, null);
    assert.equal(s.styleRef, null);
    assert.deepEqual(s.clips, []);
    assert.deepEqual(s.clip, { value: '', path: null, exists: false });
    assert.equal(s.audioDir, join(dir, 'audio'));
    assert.equal(s.audioCount, 0);
    assert.deepEqual(s.output, {
      path: join(dir, 'out', 'final_ambient.mp4'),
      exists: false,
      tracklistPath: join(dir, 'out', 'tracklist.txt'),
      tracklistExists: false,
    });
    assert.equal(s.promptsPath, join(dir, 'prompts.md'));
    assert.equal(nextStep(s).id, 'faz1');
  });

  test('açı varyantı MASTER sayılmaz; MASTER.PNG sayılır → audio', async () => {
    await writeFile(join(dir, 'resimler', 'Master1.jpg'), '');
    assert.equal(nextStep(await inspectProject(dir)).id, 'faz1');

    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    const s = await inspectProject(dir);
    assert.equal(s.master, join(dir, 'resimler', 'MASTER.PNG'));
    assert.equal(nextStep(s).id, 'audio');
  });

  test('parça konunca → multi-track tamamlanana kadar audio adımında kalır; hepsi tamamlanınca → klip beklentisine geçer; klip yazılınca → build', async () => {
    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    await writeFile(join(dir, 'audio', 'a [usesuno.com].m4a'), '');
    let s = await inspectProject(dir);
    assert.equal(s.audioCount, 1);
    // multi-track projede (17 track) 1 track yetmez, audio adımında kalır:
    assert.equal(nextStep(s).id, 'audio');

    // music planını tamamlanmış sayalım (1/1):
    const data = s.projectJson.data;
    data.music.totalTracks = 1;
    data.music.completedCount = 1;
    data.music.tracks = [data.music.tracks[0]];
    data.music.tracks[0].status = 'completed';
    await writeFile(s.projectPath, JSON.stringify(data, null, 2));

    s = await inspectProject(dir);
    assert.equal(nextStep(s).id, 'faz3');

    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    s = await inspectProject(dir);
    assert.equal(nextStep(s).id, 'clip');

    await setProjectClip(s.projectPath, s.clips[0]);
    s = await inspectProject(dir);
    assert.equal(nextStep(s).id, 'build');
  });

  test('çıktı dosyası konunca → done', async () => {
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), '');
    assert.equal(nextStep(await inspectProject(dir)).id, 'done');
  });
});

describe('listProjects', () => {
  let root;
  before(async () => { root = await tempDir('list-projects'); });
  after(() => root?.cleanup());

  test('project.json\'lu klasörler, son değişen en üstte; dosyalar ve json\'suz klasör atlanır', async () => {
    const videos = root.path('videolar');
    for (const name of ['eski', 'yeni', 'bos-klasor']) await mkdir(join(videos, name), { recursive: true });
    await writeFile(join(videos, 'eski', 'project.json'), '{}');
    await writeFile(join(videos, 'yeni', 'project.json'), '{}');
    await writeFile(join(videos, 'notlar.txt'), '');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(videos, 'eski'), old, old);
    await utimes(join(videos, 'eski', 'project.json'), old, old);

    const projects = await listProjects(videos);
    assert.deepEqual(projects.map((p) => p.name), ['yeni', 'eski']);
    assert.equal(projects[0].dir, join(videos, 'yeni'));
    assert.equal(projects[0].step.id, 'faz1');
  });

  test('videolar kökü yoksa boş liste', async () => {
    assert.deepEqual(await listProjects(root.path('yok')), []);
  });
});

describe('inspectProject — kenar durumlar', () => {
  let root;
  before(async () => { root = await tempDir('project-status-edge'); });
  after(() => root?.cleanup());

  test('project.json yok ya da bozuk → fix-project; klasörler yoksa boş sayılır', async () => {
    const empty = root.path('bos');
    await mkdir(empty);
    let s = await inspectProject(empty);
    assert.deepEqual(s.projectJson, { ok: false, data: null, error: 'dosya yok' });
    assert.deepEqual([s.clips, s.audioCount, s.master], [[], 0, null]);
    assert.equal(nextStep(s).id, 'fix-project');

    await writeFile(join(empty, 'project.json'), '{ "clip": ');
    s = await inspectProject(empty);
    assert.ok(s.projectJson.error.startsWith('JSON ayrıştırılamadı'));

    await writeFile(join(empty, 'project.json'), '[]');
    assert.equal((await inspectProject(empty)).projectJson.error, 'kök bir nesne olmalı');
  });

  test('özel audioDir, output.dir ve output.name okunur; BOM\'lu project.json', async () => {
    const dir = root.path('ozel');
    await mkdir(join(dir, 'muzik'), { recursive: true });
    await writeFile(join(dir, 'muzik', 'x.mp3'), '');
    await writeFile(join(dir, 'project.json'), '\uFEFF' + JSON.stringify({
      clip: './yok.mp4', audioDir: './muzik', output: { dir: './cikti', name: 'son.mp4' },
    }));
    const s = await inspectProject(dir);
    assert.equal(s.audioCount, 1);
    assert.equal(s.output.path, join(dir, 'cikti', 'son.mp4'));
    assert.deepEqual(s.clip, { value: './yok.mp4', path: join(dir, 'yok.mp4'), exists: false });
    assert.equal(nextStep(s).id, 'faz1');
    assert.ok(nextStep(s).detail.startsWith("clip'teki dosya bulunamadı"));
  });
});
