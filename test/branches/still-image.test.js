/**
 * Tek resim kaynağı (video.source = "image"), gerçek encode ile.
 *
 * Görsel 01-video-prep'te 5 sn'lik sabit base.mp4'e çevrilir; montaj onu klip
 * gibi kopyalar. Kırpma onayı ve loop kontrolü bu yolda yok.
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { ffmpeg } from '../../core/ffmpeg.js';
import { createWorkspace } from '../../core/workspace.js';
import { ClipNotVideoError, prepareVideo } from '../../steps/01-video-prep.js';
import { assembleVideo } from '../../steps/04-assemble.js';
import { makeTone, tempDir } from '../helpers/fixtures.js';

describe('tek resim kaynağı', () => {
  let dir;
  let workspace;
  let image;
  let prep;
  let asked = false;

  before(async () => {
    dir = await tempDir('still');
    workspace = await createWorkspace();
    image = dir.path('MASTER.png');
    // 16:10 → 16:9 kırpması da sınansın.
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1280x800', '-frames:v', '1', '-update', '1', '-y', image]);
    prep = await prepareVideo({
      clipPath: image, source: 'image', outputPath: dir.path('base.mp4'), workspace,
      verifyCrop: true, confirm: async () => { asked = true; return true; },
    });
  });

  after(async () => {
    await workspace?.cleanup();
    await dir?.cleanup();
  });

  test('5 sn, 30 fps, 16:9 kırpılmış, sessiz base.mp4', () => {
    assert.ok(Math.abs(prep.result.duration - 5) < 0.05, `süre ${prep.result.duration}`);
    assert.equal(prep.result.fps, 30);
    assert.deepEqual([prep.result.width, prep.result.height], [1280, 720]);
    assert.equal(prep.result.hasAudio, false);
    assert.equal(prep.source.kind, 'image');
  });

  test('kırpma onayı sorulmaz, kontrol karesi ve loop ölçümü üretilmez', async () => {
    assert.equal(asked, false);
    assert.equal(prep.crop.approval.reason, 'image');
    assert.equal(prep.loop, null);
    assert.equal(await access(workspace.path('crop-check.png')).then(() => true, () => false), false);
  });

  test('montaj görseli müzik boyunca kopyalar (tam encode\'a düşmeden)', async () => {
    const tone = await makeTone(dir.path('tone12.m4a'), { seconds: 12 });
    const report = await assembleVideo({
      videoPath: prep.output, audioPath: tone, outputPath: dir.path('final.mp4'), workspace, fadeOut: 2,
    });
    assert.equal(report.method, 'copy-body+encode-tail');
    assert.ok(Math.abs(report.result.duration - 12) < 0.05, `süre ${report.result.duration}`);
  });

  test('.jfif (Chrome\'un JPEG\'i) da kaynak olur', async () => {
    const jfif = dir.path('MASTER.jfif');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080', '-frames:v', '1', '-update', '1', '-c:v', 'mjpeg', '-f', 'image2', '-y', jfif]);
    const report = await prepareVideo({
      clipPath: jfif, source: 'image', outputPath: dir.path('base-jfif.mp4'), workspace,
    });
    assert.deepEqual([report.result.width, report.result.height], [1920, 1080]);
    assert.ok(Math.abs(report.result.duration - 5) < 0.05, `süre ${report.result.duration}`);
  });

  test('clip modunda aynı görsel hâlâ ClipNotVideoError', async () => {
    await assert.rejects(
      prepareVideo({ clipPath: image, outputPath: dir.path('x.mp4'), workspace, cropFromConfig: true }),
      ClipNotVideoError,
    );
  });
});
