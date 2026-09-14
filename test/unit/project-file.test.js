/**
 * prep/project-file.js — setProjectClip (geçici klasörde küçük dosyalar).
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { loadProject } from '../../core/config.js';
import { ProjectFileError, setProjectClip } from '../../prep/project-file.js';
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
