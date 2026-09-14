/**
 * P3 — Tek sayılı boyutlar (01-video-prep.js), gerçek encode ile.
 *
 * Ölçülen ffmpeg davranışı: yuv420p'de crop filtresi tek sayılı boyutu ve x
 * ofsetini HATASIZ bir aşağı yuvarlıyor. Önceki kod tek sayılı cropBottom'da
 * onay sorup encode ettikten sonra "Kırpma tutmadı: 1950×1096, beklenen
 * 1950×1097" diye düşüyordu; kontrol olmasa kullanıcının 151'i 152 olurdu.
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { createWorkspace } from '../../core/workspace.js';
import { CropSizeError, prepareVideo } from '../../steps/01-video-prep.js';
import {
  extractFrame, makeDriftingClip, makeLosslessClip, psnr, tempDir,
} from '../helpers/fixtures.js';

describe('tek sayılı boyutlar', () => {
  let dir;

  before(async () => { dir = await tempDir('odd'); });
  after(() => dir?.cleanup());

  /** Onay isteyen kurulumla çalıştırır; onayın sorulup sorulmadığını döndürür. */
  const run = async (clipPath, options) => {
    const workspace = await createWorkspace();
    const outputPath = dir.path(`out-${Math.random().toString(36).slice(2, 8)}.mp4`);
    let asked = false;
    try {
      const report = await prepareVideo({
        clipPath, outputPath, workspace, loopTest: false,
        verifyCrop: true, confirm: async () => { asked = true; return true; },
        ...options,
      });
      return { report, asked, outputPath };
    } catch (error) {
      const leftovers = await Promise.all([
        access(outputPath).then(() => true, () => false),
        access(workspace.path('crop-check.png')).then(() => true, () => false),
      ]);
      return { error, asked, leftovers };
    } finally {
      await workspace.cleanup();
    }
  };

  test('tek sayılı cropBottom: onaydan ve encode\'dan önce durur, 150/152 önerir', async () => {
    const clip = await makeDriftingClip(dir.path('drift.mp4'), { frames: 24 });   // 640×510
    const r = await run(clip, { cropBottom: 151 });
    assert.ok(r.error instanceof CropSizeError, r.error?.message);
    assert.deepEqual(r.error.suggestions, [150, 152]);
    assert.equal(r.asked, false, 'onay sorulmamalı');
    assert.deepEqual(r.leftovers, [false, false], 'çıktı ve kontrol karesi üretilmemeli');
  });

  test('tek genişlikli kaynak (2945×1248) + 16:9 → 1952×1098, sol 496 gerçekten kesilmiş', async () => {
    const src = await makeLosslessClip(dir.path('w2945.mkv'), { width: 2945, height: 1248 });
    const r = await run(src, { cropBottom: 150 });
    assert.ifError(r.error);
    assert.deepEqual([r.report.result.width, r.report.result.height], [1952, 1098]);
    assert.deepEqual([r.report.aspect.left, r.report.aspect.right], [496, 497]);

    const out = await extractFrame(r.outputPath, 5, dir.path('w2945-out.png'));
    const at = async (x) => psnr(out, await extractFrame(
      src, 5, dir.path(`w2945-x${x}.png`), `crop=iw:ih-150:0:0,crop=1952:1098:${x}:0`,
    ));
    const [p496, p494, p498] = [await at(496), await at(494), await at(498)];
    assert.ok(p496 > 40, `x=496 PSNR ${p496}`);
    assert.ok(p496 > p494 + 8 && p496 > p498 + 8, `x=496 ${p496}, 494 ${p494}, 498 ${p498}`);
  });

  test('fark 4\'e bölünmüyor (2946): rapor edilen sol kesim (496) gerçek kesimle aynı', async () => {
    const src = await makeLosslessClip(dir.path('w2946.mkv'), { width: 2946, height: 1248 });
    const r = await run(src, { cropBottom: 150 });
    assert.ifError(r.error);
    assert.deepEqual([r.report.aspect.left, r.report.aspect.right], [496, 498]);

    const out = await extractFrame(r.outputPath, 5, dir.path('w2946-out.png'));
    const at = async (x) => psnr(out, await extractFrame(
      src, 5, dir.path(`w2946-x${x}.png`), `crop=iw:ih-150:0:0,crop=1952:1098:${x}:0`,
    ));
    const [p496, p498] = [await at(496), await at(498)];
    assert.ok(p496 > p498 + 8, `x=496 ${p496}, 498 ${p498}`);
  });

  test('tek genişlik + en-boy kapalı → CropSizeError, onay sorulmaz', async () => {
    const src = dir.path('w2945.mkv');
    const r = await run(src, { cropBottom: 150, aspect: null });
    assert.ok(r.error instanceof CropSizeError, r.error?.message);
    assert.match(r.error.message, /genişliği tek sayı \(2945\)/);
    assert.equal(r.asked, false);
  });

  test('zaten 16:9 sayılan tek genişlik (1921×1230 → 1921×1080, adım atlanır) → CropSizeError', async () => {
    const src = await makeLosslessClip(dir.path('w1921.mkv'), { width: 1921, height: 1230 });
    const r = await run(src, { cropBottom: 150 });
    assert.ok(r.error instanceof CropSizeError, r.error?.message);
    assert.equal(r.asked, false);
  });
});
