/**
 * prep/ambients.js — ambient klasörü taraması ve ad eşleme.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { AmbientError, findAmbient, listAmbients } from '../../prep/ambients.js';
import { tempDir } from '../helpers/fixtures.js';

describe('ambient kütüphanesi', () => {
  let dir;
  before(async () => {
    dir = await tempDir('ambients');
    for (const file of ['rainStorm.mp3', 'campfire.mp3', 'heavyRain.MP3', 'forest birds.wav', 'notes.txt']) {
      await writeFile(dir.path(file), '');
    }
    await mkdir(dir.path('alt.mp3')); // uzantılı klasör dosya sayılmaz
  });
  after(() => dir?.cleanup());

  test('yalnızca ses dosyaları, uzantısız ad, doğal sıra', async () => {
    const ambients = await listAmbients(dir.dir);
    assert.deepEqual(ambients.map((a) => a.name), ['campfire', 'forest birds', 'heavyRain', 'rainStorm']);
    assert.equal(ambients[0].path, dir.path('campfire.mp3'));
  });

  test('ad eşleme: büyük/küçük harf duyarsız, uzantılı ad da olur', async () => {
    const ambients = await listAmbients(dir.dir);
    assert.equal(findAmbient(ambients, 'heavyRain')?.path, dir.path('heavyRain.MP3'));
    assert.equal(findAmbient(ambients, 'HEAVYRAIN')?.name, 'heavyRain');
    assert.equal(findAmbient(ambients, 'campfire.mp3')?.name, 'campfire');
    assert.equal(findAmbient(ambients, ' forest birds ')?.name, 'forest birds');
  });

  test('olmayan ad → null', async () => {
    const ambients = await listAmbients(dir.dir);
    assert.equal(findAmbient(ambients, 'ocean'), null);
    assert.equal(findAmbient(ambients, 'notes'), null);
    assert.equal(findAmbient(ambients, 'campfire.wav'), null);
  });

  test('klasör yok → AmbientError', async () => {
    await assert.rejects(listAmbients(dir.path('yok')), (e) =>
      e instanceof AmbientError && e.message.includes('ENOENT'));
  });
});
