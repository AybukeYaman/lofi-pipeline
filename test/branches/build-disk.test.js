/**
 * P5 — Disk yetersizliği (build.js → checkDiskSpace), boş alan enjekte edilerek.
 *
 * Gerçek dar disk kurmak yönetici izni ister; bunun yerine runBuild'e
 * `diskFree` verilir. Beklenen: montajdan ÖNCE BuildError, workspace silinmiş,
 * çıktı klasöründe hiçbir şey yok.
 */

import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { BuildError, runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

describe('disk yetersizliği', () => {
  let dir;
  let config;

  before(async () => {
    dir = await tempDir('disk');
    await makeDriftingClip(dir.path('clip.mp4'), { frames: 124 });
    await mkdir(dir.path('audio'));
    for (const [name, frequency] of [['a', 300], ['b', 500], ['c', 700]]) {
      await makeTone(dir.path(`audio/${name}.m4a`), { seconds: 12, frequency });
    }
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      video: { cropBottom: 150 },
    }));
    config = await loadProject(dir.path('project.json'));
  });

  after(() => dir?.cleanup());

  const run = async (diskFree) => {
    const logs = [];
    const asked = [];
    try {
      const report = await runBuild(config, {
        diskFree: async (path) => { asked.push(path); return diskFree; },
        overwrite: true,
        loggerFor: (tag) => ({
          info: (m) => logs.push(`[${tag}] ${m}`),
          warn: (m) => logs.push(`[${tag}] UYARI ${m}`),
        }),
      });
      return { report, logs, asked };
    } catch (error) {
      return { error, logs, asked };
    }
  };

  test('boş alan yetmezse montajdan önce BuildError, workspace silinir, çıktı yok', async () => {
    const { error, logs, asked } = await run(1024);

    assert.ok(error instanceof BuildError, error?.stack);
    assert.match(error.message, /^Disk yetersiz: ~\d+\.\d\d GB gerekli, 0\.00 GB boş \(/);
    assert.deepEqual(asked, [config.output.dir], 'boş alan çıktı klasörü için sorulmalı');

    // 01 ve 02 çalıştı, 04 hiç başlamadı.
    assert.ok(logs.some((l) => l.startsWith('[02]') && l.includes('bitti')));
    assert.ok(!logs.some((l) => l.startsWith('[04]')), logs.join('\n'));
    assert.ok(logs.some((l) => l.includes('Workspace temizlendi')));

    assert.deepEqual(await readdir(config.output.dir), []);
  });

  test('gereken alan tahmini: yeterli boş alanla build tamamlanır ve tahmini raporlar', async () => {
    const { report, error } = await run(10 * 1024 ** 3);
    assert.ifError(error);
    assert.equal(report.disk.freeBytes, 10 * 1024 ** 3);
    // Tahmin gerçek çıktıdan küçük olmamalı (pay dahil).
    const { size } = report.details['04'].result;
    assert.ok(report.disk.requiredBytes >= size, `tahmin ${report.disk.requiredBytes}, montaj ${size}`);
    assert.deepEqual(
      (await readdir(config.output.dir)).sort(),
      ['final_ambient.mp4', 'final_ambient.report.json', 'tracklist.txt'],
    );
  });

  test('sınırda: gereken alan kadar boş alan yeter, bir bayt eksiği yetmez', async () => {
    const { report } = await run(10 * 1024 ** 3);
    const required = report.disk.requiredBytes;

    const exact = await run(required);
    assert.ifError(exact.error);

    const short = await run(required - 1);
    assert.ok(short.error instanceof BuildError, short.error?.message);
  });
});
