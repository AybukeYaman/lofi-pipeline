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
    await mkdir(dir.path('audio'));
  });
  after(() => dir?.cleanup());

  test('crossfadeSeconds varsayılan 0, bilinen anahtar', async () => {
    const c = await loadProject(await write('default'));
    assert.equal(c.video.crossfadeSeconds, 0);
    assert.deepEqual(c.warnings, []);
  });

  test('crossfadeSeconds konfigden okunur', async () => {
    const c = await loadProject(await write('set', { video: { crossfadeSeconds: 1.5 } }));
    assert.equal(c.video.crossfadeSeconds, 1.5);
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
