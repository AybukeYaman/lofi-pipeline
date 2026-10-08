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
import { loadProject } from '../../core/config.js';
import { audioAddedOrder, canonicalWorkflow, inspectProject, listProjects, nextStep } from '../../prep/project-status.js';
import { recordAudioAdded } from '../../prep/project-file.js';
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
      // Bu senaryo plan tabanlı müzik akışını izliyor; plan artık yalnızca
      // açıkça istenince yazılıyor.
      totalTracks: 17,
    }));
  });
  after(() => root?.cleanup());

  test('taze proje: faz3, yollar ve varsayılan çıktı', async () => {
    const s = await inspectProject(dir);
    assert.equal(s.projectJson.ok, true);
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
    assert.equal(nextStep(s).id, 'faz3');
  });

  test('resimler\ altındaki görseller aday listesine girer', async () => {
    await writeFile(join(dir, 'resimler', 'Master1.jpg'), '');
    assert.equal(nextStep(await inspectProject(dir)).id, 'faz3');

    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    const s = await inspectProject(dir);
    assert.equal(nextStep(s).id, 'faz3');
  });

  test('klip hazır olunca → audio (müzik) adımına geçer; müzik tamamlanınca → build', async () => {
    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    let s = await inspectProject(dir);
    assert.equal(nextStep(s).id, 'clip');

    await setProjectClip(s.projectPath, s.clips[0]);
    s = await inspectProject(dir);
    // Klip hazır, henüz müzik yok → audio adımı
    assert.equal(nextStep(s).id, 'audio');

    // 1 müzik parçası koyduk ama multi-track tamamlanmadı → audio'da kalır
    await writeFile(join(dir, 'audio', 'a [usesuno.com].m4a'), '');
    s = await inspectProject(dir);
    assert.equal(s.audioCount, 1);
    assert.equal(nextStep(s).id, 'audio');

    // music planını tamamlanmış sayalım (1/1):
    const data = s.projectJson.data;
    data.music.totalTracks = 1;
    data.music.completedCount = 1;
    data.music.tracks = [data.music.tracks[0]];
    data.music.tracks[0].status = 'completed';
    await writeFile(s.projectPath, JSON.stringify(data, null, 2));

    // Hem klip hem müzik hazır → build
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
    assert.equal(projects[0].step.id, 'faz3');
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
    assert.deepEqual([s.clips, s.audioCount], [[], 0]);
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
    assert.equal(nextStep(s).id, 'faz3');
    assert.ok(nextStep(s).detail.startsWith("clip'teki dosya bulunamadı"));
  });
});

describe('tek resim modu — new-video\'dan montaj konfigine', () => {
  let root;
  let dir;

  before(async () => {
    root = await tempDir('project-status-still');
    await mkdir(root.path('videolar'));
    await mkdir(root.path('ambient'));
    ({ dir } = await runNewVideo({
      videoName: 'still',
      styleName: 'cozy-realistic',
      videoSource: 'image',
      videosDir: root.path('videolar'),
      ambientDir: root.path('ambient'),
    }));
  });
  after(() => root?.cleanup());

  test('project.json: source image, kırpma 0; görsel yokken küçük resim yok', async () => {
    const s = await inspectProject(dir);
    assert.deepEqual(s.projectJson.data.video, { source: 'image', cropBottom: 0, aspect: '16:9' });
    assert.equal(s.videoSource, 'image');
    assert.equal(s.thumbnail, null);
  });

  test('adaylar MASTER + açılar (videolar\ yok sayılır); seçilen görsel küçük resim olur', async () => {
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    await writeFile(join(dir, 'resimler', 'Master2.jpg'), '');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    let s = await inspectProject(dir);
    assert.deepEqual(s.clips, [join(dir, 'resimler', 'MASTER.png'), join(dir, 'resimler', 'Master2.jpg')]);
    assert.equal(s.thumbnail, s.clips[0]);
    assert.equal(nextStep(s).id, 'clip');

    await setProjectClip(s.projectPath, s.clips[1]);
    s = await inspectProject(dir);
    assert.equal(s.thumbnail, join(dir, 'resimler', 'Master2.jpg'));
    assert.equal(nextStep(s).id, 'audio');
    assert.equal(canonicalWorkflow(s).current, 'music');

    const config = await loadProject(s.projectPath);
    assert.equal(config.video.source, 'image');
    assert.equal(config.clip, join(dir, 'resimler', 'Master2.jpg'));

    const [listed] = await listProjects(root.path('videolar'));
    assert.equal(listed.thumbnail, s.thumbnail);
  });
});

describe('audioAddedOrder — 8. adım "Eklediğim sıra"', () => {
  let root;
  before(async () => { root = await tempDir('added-order'); });
  after(() => root?.cleanup());

  test('kayıtlılar kayıt sırasıyla, kaydı olmayanlar sonra oluşturulma zamanına göre; silinen kayıt atlanır', async () => {
    const dir = root.path('p');
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'project.json'), JSON.stringify({ clip: '', audioDir: './audio' }));
    for (const name of ['z.mp3', 'y.mp3']) {
      await writeFile(join(dir, 'audio', name), '');
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
    }
    await writeFile(join(dir, 'audio', 'm.mp3'), '');
    await writeFile(join(dir, 'audio', 'a.mp3'), '');
    await recordAudioAdded(join(dir, 'project.json'), ['m.mp3', 'silindi.mp3', 'a.mp3']);

    assert.deepEqual(await audioAddedOrder(await inspectProject(dir)), ['m.mp3', 'a.mp3', 'z.mp3', 'y.mp3']);
  });
});
