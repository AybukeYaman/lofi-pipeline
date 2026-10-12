/**
 * project.json okuması yarım yazılmış dosyaya dayanıklı olmalı: yazan taraf
 * dosyayı önce boşaltıp sonra doldurduğu için okuyucu kısa süre geçersiz JSON
 * görebilir (Shorts render bitişinde arayüz yoklaması buna denk geliyordu).
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { inspectProject } from '../../prep/project-status.js';
import { tempDir } from '../helpers/fixtures.js';

describe('project.json okuması', () => {
  let dir;
  before(async () => { dir = await tempDir('project-json-read'); });
  after(() => dir?.cleanup());

  async function makeProject(name, content) {
    const projectDir = dir.path(name);
    await mkdir(projectDir, { recursive: true });
    await writeFile(`${projectDir}/project.json`, content);
    return projectDir;
  }

  test('yarım yazılmış dosya kısa süre sonra tamamlanırsa geçerli okunur', async () => {
    const projectDir = await makeProject('partial', '{"clip": "./a.mp4", "au');
    setTimeout(() => {
      void writeFile(`${projectDir}/project.json`, JSON.stringify({ clip: './a.mp4', audioDir: './audio' }));
    }, 30);

    const status = await inspectProject(projectDir);
    assert.equal(status.projectJson.ok, true, status.projectJson.error);
    assert.equal(status.projectJson.data.clip, './a.mp4');
  });

  test('boş dosya da tamamlanınca okunur', async () => {
    const projectDir = await makeProject('empty', '');
    setTimeout(() => {
      void writeFile(`${projectDir}/project.json`, JSON.stringify({ clip: '', audioDir: './audio' }));
    }, 30);
    const status = await inspectProject(projectDir);
    assert.equal(status.projectJson.ok, true, status.projectJson.error);
  });

  test('gerçekten bozuk dosya yine hata verir', async () => {
    const projectDir = await makeProject('broken', '{ bu json degil');
    const status = await inspectProject(projectDir);
    assert.equal(status.projectJson.ok, false);
    assert.match(status.projectJson.error, /JSON ayrıştırılamadı/);
  });

  test('dosya yoksa beklemeden "dosya yok"', async () => {
    const projectDir = dir.path('missing');
    await mkdir(projectDir, { recursive: true });
    const started = Date.now();
    const status = await inspectProject(projectDir);
    assert.equal(status.projectJson.ok, false);
    assert.equal(status.projectJson.error, 'dosya yok');
    assert.ok(Date.now() - started < 500);
  });
});
