/**
 * Onaylanmayan kırpma (build.js → keepCropFrame).
 *
 * Workspace `finally`'de silinir; hatanın gösterdiği kontrol karesi yolu
 * kullanıcıya ulaştığında hâlâ açılabilir olmalı (HANDOFF bölüm 15, açık iş 2).
 */

import assert from 'node:assert/strict';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { CropNotConfirmedError } from '../../steps/01-video-prep.js';
import { makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

describe('onaylanmayan kırpma', () => {
  let dir;
  let config;

  before(async () => {
    dir = await tempDir('crop-confirm');
    await makeDriftingClip(dir.path('clip.mp4'), { frames: 48 });
    await mkdir(dir.path('audio'));
    await makeTone(dir.path('audio/a.m4a'), { seconds: 4 });
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      video: { cropBottom: 150 },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
    }));
    config = await loadProject(dir.path('project.json'), { verifyCrop: true });
  });

  after(() => dir?.cleanup());

  const run = async (options) => {
    const logs = [];
    try {
      await runBuild(config, {
        render: true,
        overwrite: true,
        loggerFor: () => ({ info: (m) => logs.push(m), warn: (m) => logs.push(m) }),
        ...options,
      });
      return { logs };
    } catch (error) {
      return { error, logs };
    }
  };

  for (const [label, options] of [
    ['onay sorulamazsa', {}],
    ['onay reddedilirse', { confirm: async () => false }],
  ]) {
    test(`${label}: hata çıktı klasöründeki, var olan kontrol karesini gösterir`, async () => {
      const { error, logs } = await run(options);

      assert.ok(error instanceof CropNotConfirmedError, error?.stack);
      const keptPath = join(config.output.dir, 'crop-check.png');
      assert.equal(error.framePath, keptPath);
      assert.ok(error.message.endsWith(keptPath), error.message);
      await access(keptPath);

      // Workspace yine silindi; çıktı klasöründe yalnızca kontrol karesi var.
      assert.ok(logs.some((l) => l.includes('Workspace temizlendi')), logs.join('\n'));
      assert.deepEqual(await readdir(config.output.dir), ['crop-check.png']);
    });
  }
});
