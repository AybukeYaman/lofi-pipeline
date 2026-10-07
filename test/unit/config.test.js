/**
 * core/config.js — project.json doğrulaması (medya çözülmez, dosyalar boş).
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { ConfigError, loadProject } from '../../core/config.js';
import { tempDir } from '../helpers/fixtures.js';

describe('project.json', () => {
  let dir;

  /** Geçerli en küçük konfig + üzerine yazılanlar. */
  const write = async (name, patch = {}) => {
    const json = { clip: './in.mp4', audioDir: './audio', ...patch };
    json.video = { cropBottom: 150, ...(patch.video ?? {}) };
    const path = dir.path(`${name}.json`);
    await writeFile(path, JSON.stringify(json));
    return path;
  };

  before(async () => {
    dir = await tempDir('config');
    await writeFile(dir.path('in.mp4'), '');
    await writeFile(dir.path('MASTER.png'), '');
    await mkdir(dir.path('audio'));
  });
  after(() => dir?.cleanup());

  test('video.source varsayılan clip; image + görsel kabul edilir', async () => {
    assert.equal((await loadProject(await write('src-default'))).video.source, 'clip');
    const c = await loadProject(await write('src-image', { clip: './MASTER.png', video: { source: 'image', cropBottom: 0 } }));
    assert.equal(c.video.source, 'image');
    assert.deepEqual(c.warnings, []);
  });

  test('video.source ile klip türü uyuşmazsa ve bilinmeyen değerde ConfigError', async () => {
    const problemOf = async (name, patch) => {
      const error = await loadProject(await write(name, patch)).then(() => null, (e) => e);
      assert.ok(error instanceof ConfigError, name);
      return error.problems.join(' | ');
    };
    assert.match(await problemOf('src-image-mp4', { video: { source: 'image' } }), /görsel olmalı/);
    assert.match(await problemOf('src-clip-png', { clip: './MASTER.png' }), /video.source: "image" yaz/);
    assert.match(await problemOf('src-bad', { video: { source: 'gif' } }), /video.source: "clip" ya da "image"/);
  });

  test('crossfadeSeconds varsayılan 0, bilinen anahtar', async () => {
    const c = await loadProject(await write('default'));
    assert.equal(c.video.crossfadeSeconds, 0);
    assert.deepEqual(c.warnings, []);
  });

  test('crossfadeSeconds konfigden okunur', async () => {
    const c = await loadProject(await write('set', { video: { crossfadeSeconds: 1.5 } }));
    assert.equal(c.video.crossfadeSeconds, 1.5);
  });

  test('BOM\'lu project.json okunur', async () => {
    const path = dir.path('bom.json');
    await writeFile(path, '\uFEFF' + JSON.stringify({ clip: './in.mp4', audioDir: './audio', video: { cropBottom: 150 } }));
    assert.equal((await loadProject(path)).video.cropBottom, 150);
  });

  test('boş yol metinleri tek problem verir, klasöre çözülmez', async () => {
    await assert.rejects(loadProject(await write('empty', { clip: '', audioDir: ' ', ambient: '' })), (e) =>
      e instanceof ConfigError &&
      assert.deepEqual(e.problems, [
        'clip: boş olmayan bir metin olmalı',
        'audioDir: boş olmayan bir metin olmalı',
        'ambient[0]: boş olmayan bir metin olmalı',
      ]) === undefined);
  });

  test('okuma ve ayrıştırma hataları ayrı mesajla', async () => {
    await assert.rejects(loadProject(dir.path('yok.json')), (e) =>
      e instanceof ConfigError && e.problems[0] === 'dosya okunamadı: ENOENT');
    const broken = dir.path('broken.json');
    await writeFile(broken, '{ "clip": ');
    await assert.rejects(loadProject(broken), (e) =>
      e instanceof ConfigError && e.problems[0].startsWith('JSON ayrıştırılamadı:'));
  });

  for (const bad of [-1, '1', 61]) {
    test(`crossfadeSeconds ${JSON.stringify(bad)} → ConfigError`, async () => {
      await assert.rejects(
        loadProject(await write(`bad-${String(bad)}`, { video: { crossfadeSeconds: bad } })),
        (e) => e instanceof ConfigError && e.problems.some((p) => p.startsWith('video.crossfadeSeconds')),
      );
    });
  }
});
