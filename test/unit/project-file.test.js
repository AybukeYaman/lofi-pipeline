/**
 * prep/project-file.js — setProjectClip, watermark kırpması (geçici klasörde küçük dosyalar).
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loadProject } from '../../core/config.js';
import {
  DEFAULT_CROP_BOTTOM, ProjectFileError, cropForWatermark, recordAudioAdded, setProjectClip, setProjectCropBottom,
} from '../../prep/project-file.js';
import { tempDir } from '../helpers/fixtures.js';

describe('setProjectClip', () => {
  let root;
  let n = 0;

  /** Proje klasörü: project.json + audio/ + videolar/in.mp4 */
  const makeProject = async (content) => {
    const dir = root.path(`p${n++}`);
    await mkdir(join(dir, 'audio'), { recursive: true });
    await mkdir(join(dir, 'videolar'));
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const projectPath = join(dir, 'project.json');
    await writeFile(projectPath, content ?? JSON.stringify({
      clip: '', audioDir: './audio', order: ['b', 'a'], video: { cropBottom: 150, aspect: '16:9' }, output: { dir: './out' },
    }));
    return { dir, projectPath };
  };

  before(async () => { root = await tempDir('project-file'); });
  after(() => root?.cleanup());

  test('mutlak yol → göreli ./ biçimi; diğer anahtarlar ve sıra korunur; loadProject çözer', async () => {
    const { dir, projectPath } = await makeProject();
    assert.equal(await setProjectClip(projectPath, join(dir, 'videolar', 'in.mp4')), './videolar/in.mp4');

    const text = await readFile(projectPath, 'utf8');
    const json = JSON.parse(text);
    assert.deepEqual(Object.keys(json), ['clip', 'audioDir', 'order', 'video', 'output']);
    assert.deepEqual(json, {
      clip: './videolar/in.mp4', audioDir: './audio', order: ['b', 'a'],
      video: { cropBottom: 150, aspect: '16:9' }, output: { dir: './out' },
    });
    assert.ok(text.endsWith('}\n') && !text.includes('\r'));

    const config = await loadProject(projectPath);
    assert.equal(config.clip, join(dir, 'videolar', 'in.mp4'));
  });

  test('göreli yol da kabul; clip anahtarı yoksa eklenir', async () => {
    const { projectPath } = await makeProject(JSON.stringify({ audioDir: './audio' }));
    assert.equal(await setProjectClip(projectPath, 'videolar\\in.mp4'), './videolar/in.mp4');
    assert.deepEqual(Object.keys(JSON.parse(await readFile(projectPath, 'utf8'))), ['audioDir', 'clip']);
  });

  test('BOM\'lu project.json okunur, BOM\'suz yazılır', async () => {
    const { projectPath } = await makeProject('\uFEFF{"clip": ""}');
    await setProjectClip(projectPath, './videolar/in.mp4');
    assert.notEqual((await readFile(projectPath))[0], 0xef);
  });

  for (const [label, clip] of [
    ['proje dışı göreli', '../baska/in.mp4'],
    ['proje klasörünün kendisi', '.'],
  ]) {
    test(`${label} → ProjectFileError, dosyaya dokunulmaz`, async () => {
      const { projectPath } = await makeProject();
      const before = await readFile(projectPath, 'utf8');
      await assert.rejects(setProjectClip(projectPath, clip), (e) =>
        e instanceof ProjectFileError && e.message.startsWith('klip proje klasörünün içinde olmalı'));
      assert.equal(await readFile(projectPath, 'utf8'), before);
    });
  }

  test('proje dışı mutlak yol ve olmayan dosya reddedilir', async () => {
    const { projectPath } = await makeProject();
    const outside = root.path('disari.mp4');
    await writeFile(outside, '');
    await assert.rejects(setProjectClip(projectPath, outside), /proje klasörünün içinde/);
    await assert.rejects(setProjectClip(projectPath, './videolar/yok.mp4'), (e) =>
      e instanceof ProjectFileError && e.message.startsWith('klip dosyası bulunamadı'));
  });

  test('bozuk project.json → ProjectFileError', async () => {
    const { projectPath } = await makeProject('{ bozuk');
    await assert.rejects(setProjectClip(projectPath, './videolar/in.mp4'), (e) =>
      e instanceof ProjectFileError && e.message.startsWith('project.json ayrıştırılamadı'));
  });
});

describe('watermark kırpması', () => {
  let root;

  before(async () => { root = await tempDir('project-crop'); });
  after(() => root?.cleanup());

  test('cropForWatermark: kapalı 0; açık → geçerli pozitif değer korunur, yoksa varsayılan', () => {
    assert.equal(cropForWatermark(false, 150), 0);
    assert.equal(cropForWatermark(true, 90), 90);
    for (const current of [0, undefined, null, -5, 12.5, '150']) {
      assert.equal(cropForWatermark(true, current), DEFAULT_CROP_BOTTOM);
    }
  });

  test('setProjectCropBottom yalnızca video.cropBottom değiştirir; loadProject konfigden okur', async () => {
    await mkdir(root.path('audio'), { recursive: true });
    await mkdir(root.path('videolar'));
    await writeFile(root.path('videolar/in.mp4'), '');
    const projectPath = root.path('project.json');
    await writeFile(projectPath, JSON.stringify({
      clip: './videolar/in.mp4', audioDir: './audio', video: { aspect: '16:9', cropBottom: 150, crf: 20 },
    }));
    assert.equal(await setProjectCropBottom(projectPath, 0), 0);
    const json = JSON.parse(await readFile(projectPath, 'utf8'));
    assert.deepEqual(json, { clip: './videolar/in.mp4', audioDir: './audio', video: { aspect: '16:9', cropBottom: 0, crf: 20 } });

    const config = await loadProject(projectPath);
    assert.equal(config.video.cropBottom, 0);
    assert.equal(config.video.cropFromConfig, true); // build.js onay istemez
  });

  test('video yoksa oluşturulur; geçersiz değer ve video nesne değilse ProjectFileError', async () => {
    const projectPath = root.path('p2.json');
    await writeFile(projectPath, '{"clip": ""}');
    await setProjectCropBottom(projectPath, 120);
    assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')), { clip: '', video: { cropBottom: 120 } });

    for (const bad of [-1, 1.5, '150', null]) {
      await assert.rejects(setProjectCropBottom(projectPath, bad), ProjectFileError);
    }
    await writeFile(projectPath, '{"video": "x"}');
    await assert.rejects(setProjectCropBottom(projectPath, 0), /"video" bir nesne/);
    assert.equal(await readFile(projectPath, 'utf8'), '{"video": "x"}');
  });
});

describe('recordAudioAdded', () => {
  let root;
  before(async () => { root = await tempDir('audio-added'); });
  after(() => root?.cleanup());

  test('eklenme sırası workflow.audioAdded\'a yazılır; yeniden eklenen sona taşınır, diğer alanlar korunur', async () => {
    const projectPath = root.path('project.json');
    await writeFile(projectPath, JSON.stringify({ clip: '', workflow: { order: 'manual' } }));
    assert.deepEqual(await recordAudioAdded(projectPath, ['b.mp3', 'a.mp3']), ['b.mp3', 'a.mp3']);
    assert.deepEqual(await recordAudioAdded(projectPath, ['c.mp3', 'b.mp3']), ['a.mp3', 'c.mp3', 'b.mp3']);
    const json = JSON.parse(await readFile(projectPath, 'utf8'));
    assert.deepEqual(json.workflow, { order: 'manual', audioAdded: ['a.mp3', 'c.mp3', 'b.mp3'] });
    assert.equal(json.clip, '');
    assert.deepEqual(await recordAudioAdded(projectPath, []), []);
  });
});
