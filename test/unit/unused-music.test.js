/**
 * prep/unused-music.js — fazla müzik kırpılınca hiç kullanılmayan parçaların
 * Geri Dönüşüm Kutusu'na taşınması ve project.json'dan çıkarılması.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { planTrim } from '../../core/pomodoro-plan.js';
import { forgetAudioFiles } from '../../prep/project-file.js';
import { discardUnusedMusic } from '../../prep/unused-music.js';
import { tempDir } from '../helpers/fixtures.js';

describe('discardUnusedMusic', () => {
  let dir;
  before(async () => { dir = await tempDir('unused-music'); });
  after(() => dir?.cleanup());

  const read = async (path) => JSON.parse(await readFile(path, 'utf8'));
  const tracks = [
    { path: 'C:\\m\\01.mp3', duration: 600 },
    { path: 'C:\\m\\02.mp3', duration: 600 },
    { path: 'C:\\m\\03.mp3', duration: 600 },
    { path: 'C:\\m\\04.mp3', duration: 600 },
  ];

  test('yalnızca TAMAMEN dışarıda kalan parçalar taşınır; kısalan parça yerinde kalır', async () => {
    const projectPath = dir.path('a.json');
    await writeFile(projectPath, JSON.stringify({
      order: ['01.mp3', '02.mp3', '03.mp3', '04.mp3'],
      workflow: { audioAdded: ['01.mp3', '02.mp3', '03.mp3', '04.mp3'], order: 'manual' },
    }));
    const trashed = [];

    // 1500 sn: 01, 02 tam, 03 kısalır (300 sn), 04 hiç kullanılmaz.
    const result = await discardUnusedMusic({
      trim: planTrim(tracks, 1500),
      projectPath,
      trashFile: async (path) => { trashed.push(path); },
    });

    assert.deepEqual(trashed, ['C:\\m\\04.mp3']);
    assert.deepEqual(result, { moved: ['04.mp3'], failed: [] });
    const json = await read(projectPath);
    assert.deepEqual(json.order, ['01.mp3', '02.mp3', '03.mp3']);
    assert.deepEqual(json.workflow.audioAdded, ['01.mp3', '02.mp3', '03.mp3']);
    assert.equal(json.workflow.order, 'manual', 'diğer alanlar korunur');
  });

  test('hiçbir parça dışarıda kalmıyorsa hiçbir şey taşınmaz', async () => {
    const projectPath = dir.path('b.json');
    await writeFile(projectPath, JSON.stringify({ order: ['01.mp3', '02.mp3', '03.mp3', '04.mp3'] }));
    const trashed = [];

    // 2400 sn = tüm parçalar tam sığar.
    const result = await discardUnusedMusic({
      trim: planTrim(tracks, 2400), projectPath, trashFile: async (path) => { trashed.push(path); },
    });

    assert.deepEqual(result, { moved: [], failed: [] });
    assert.deepEqual(trashed, []);
    assert.deepEqual((await read(projectPath)).order, ['01.mp3', '02.mp3', '03.mp3', '04.mp3']);
  });

  test('taşınamayan parça hata atmaz: bildirilir, o parça kayıtlarda KALIR', async () => {
    const projectPath = dir.path('c.json');
    await writeFile(projectPath, JSON.stringify({ order: ['01.mp3', '02.mp3', '03.mp3', '04.mp3'] }));

    const result = await discardUnusedMusic({
      trim: planTrim(tracks, 1000),
      projectPath,
      trashFile: async (path) => { if (path.endsWith('04.mp3')) throw new Error('kilitli'); },
    });

    assert.deepEqual(result.moved, ['03.mp3']);
    assert.deepEqual(result.failed, [{ file: '04.mp3', error: 'kilitli' }]);
    assert.deepEqual((await read(projectPath)).order, ['01.mp3', '02.mp3', '04.mp3']);
  });
});

describe('forgetAudioFiles', () => {
  let dir;
  before(async () => { dir = await tempDir('forget-audio'); });
  after(() => dir?.cleanup());

  test('order ve audioAdded olmayan alanlarda hata vermez, başka alana dokunmaz', async () => {
    const projectPath = dir.path('p.json');
    await writeFile(projectPath, JSON.stringify({ clip: 'x.mp4', video: { cropBottom: 150 } }));
    await forgetAudioFiles(projectPath, ['a.mp3']);
    assert.deepEqual(JSON.parse(await readFile(projectPath, 'utf8')), { clip: 'x.mp4', video: { cropBottom: 150 } });
  });

  test('boş liste dosyaya hiç dokunmaz', async () => {
    const projectPath = join(dir.dir, 'q.json');
    await writeFile(projectPath, '{ "order": ["a.mp3"] }   ');
    await forgetAudioFiles(projectPath, []);
    assert.equal(await readFile(projectPath, 'utf8'), '{ "order": ["a.mp3"] }   ');
  });
});
