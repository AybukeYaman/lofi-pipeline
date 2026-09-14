/**
 * P1 — Loop crossfade (01-video-prep.js), yapay veriyle.
 *
 * Eski filtre klibin sonunu kendi öncesine karıştırıyordu; birleşme SSIM'i
 * crossfade kapalı halinden bile kötüydü (0.155 vs 0.213). Ayrıca xfade çıktıyı
 * yuv444p'ye çekiyordu (High 4:4:4, çoğu oynatıcı çözemez). Bu testler ikisini
 * de yakalar.
 *
 * Fixture: dokulu desen sabit hızla kayar — loop'u KAPANMAZ.
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { ffprobe } from '../../core/ffmpeg.js';
import { createWorkspace } from '../../core/workspace.js';
import { prepareVideo } from '../../steps/01-video-prep.js';
import { assembleVideo } from '../../steps/04-assemble.js';
import {
  countFrames, extractFrame, makeDriftingClip, makeTone, measureLoopJunction, ssim, tempDir,
} from '../helpers/fixtures.js';

const N = 124;           // klip karesi
const C = 24;            // 1 sn @ 24 fps
const CROP = 'crop=iw:ih-150:0:0';
/** Aynı karenin crf16 encode sonrası SSIM'i bu fixture'da ~0.99; pay bırakıldı. */
const SAME_FRAME = 0.95;

describe('loop crossfade', () => {
  let dir;
  let clip;
  let faded;
  let plain;
  let report;

  const src = (i) => extractFrame(clip, i, dir.path(`src-${i}.png`), CROP);
  const out = (i) => extractFrame(faded, i, dir.path(`out-${i}.png`));

  before(async () => {
    dir = await tempDir('crossfade');
    clip = await makeDriftingClip(dir.path('clip.mp4'), { frames: N });

    const run = async (name, crossfadeSeconds) => {
      const workspace = await createWorkspace();
      try {
        return await prepareVideo({
          clipPath: clip, outputPath: dir.path(name), workspace,
          cropBottom: 150, cropFromConfig: true, loopTest: false, crossfadeSeconds,
        });
      } finally {
        await workspace.cleanup();
      }
    };
    report = await run('faded.mp4', 1);
    faded = report.output;
    plain = (await run('plain.mp4', 0)).output;
  });

  after(() => dir?.cleanup());

  test('kare sayısı N−C+1, rapor planı taşıyor', async () => {
    assert.equal(await countFrames(faded), N - C + 1);
    assert.equal(report.crossfade.outputFrames, N - C + 1);
    assert.deepEqual(report.warnings, []);
  });

  test('yuv420p / High profil (4:4:4 değil)', async () => {
    const { stdout } = await ffprobe([
      '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,profile', '-of', 'csv=p=0', faded,
    ]);
    assert.equal(stdout.trim(), 'High,yuv420p');
  });

  test('ilk kare = kaynak C, son kare = kaynak C−1 (loop ardışık karelerle kapanır)', async () => {
    const first = await out(0);
    const last = await out(N - C);

    const firstVsC = await ssim(first, await src(C));
    const lastVsCm1 = await ssim(last, await src(C - 1));
    assert.ok(firstVsC >= SAME_FRAME, `ilk kare vs kaynak ${C}: ${firstVsC}`);
    assert.ok(lastVsCm1 >= SAME_FRAME, `son kare vs kaynak ${C - 1}: ${lastVsCm1}`);

    // Komşu karelerden daha iyi eşleşmeli — hizalama bir kare bile kaymasın.
    assert.ok(firstVsC > await ssim(first, await src(C + 1)));
    assert.ok(firstVsC > await ssim(first, await src(C - 1)));
    assert.ok(lastVsCm1 > await ssim(last, await src(C - 2)));
    assert.ok(lastVsCm1 > await ssim(last, await src(C)));
  });

  test('karışımdan önceki gövde değişmeden kopyalanır', async () => {
    const k = 50;
    const s = await ssim(await out(k), await src(C + k));
    assert.ok(s >= SAME_FRAME, `çıktı ${k} vs kaynak ${C + k}: ${s}`);
  });

  test('birleşme noktası klibin kendi ardışık adımlarından sert değil', async () => {
    const m = await measureLoopJunction(faded, {
      frames: N - C + 1, dir, samples: [5, 40, 70, 77, 83, 89, 95, 99],
    });
    assert.ok(
      m.junction >= m.minConsecutive - 0.02,
      `birleşme ${m.junction}, en düşük ardışık ${m.minConsecutive} (${m.consecutive.join(' ')})`,
    );
  });

  test('ölçüm ayırt edici: crossfade kapalıyken sıçrama görünür', async () => {
    const m = await measureLoopJunction(plain, { frames: N, dir });
    assert.ok(
      m.junction < m.minConsecutive - 0.3,
      `kapalıyken birleşme ${m.junction}, en düşük ardışık ${m.minConsecutive}`,
    );
  });

  test('crossfade\'li base ile montaj kopya yolunda kalır', async () => {
    const audio = await makeTone(dir.path('tone.m4a'), { seconds: 20 });
    const workspace = await createWorkspace();
    try {
      const r = await assembleVideo({
        videoPath: faded, audioPath: audio, outputPath: dir.path('assembled.mp4'), workspace,
      });
      assert.equal(r.method, 'copy-body+encode-tail');
      assert.equal(r.plan.clipFrames, N - C + 1);
      assert.equal(r.result.frames, Math.round(20 * 24));
      assert.ok(r.junctions.length === 2 && r.junctions.every((j) => j.clean));
    } finally {
      await workspace.cleanup();
    }
  });

  test('klibe sığmayan crossfade encode\'dan ve onaydan önce durur', async () => {
    const workspace = await createWorkspace();
    try {
      await assert.rejects(
        prepareVideo({
          clipPath: clip, outputPath: dir.path('too-long.mp4'), workspace,
          cropBottom: 150, verifyCrop: true, assumeApproved: true, crossfadeSeconds: 3,
        }),
        /yarısından uzun/,
      );
      await assert.rejects(access(dir.path('too-long.mp4')));
      await assert.rejects(access(workspace.path('crop-check.png')));
    } finally {
      await workspace.cleanup();
    }
  });
});
