/**
 * P2 — Montajın güvenlik ağı (04-assemble.js), yapay veriyle.
 *
 * 48 dakikalık işi kurtaran iki koruma:
 *   a) Birleştirmeden ÖNCE: kuyruğun parametre setleri gövdeyle uyuşmazsa tam
 *      encode'a düşülür.
 *   b) Birleştirmeden SONRA: birleşme noktalarında akış içi SPS/PPS konteynerle
 *      aynı mı. (Uyuşmayan kuyruk ffmpeg'de HATASIZ çözülüyor ve kareler doğru
 *      görünüyor — ölçüldü, SSIM 0.994. `-xerror` tek başına yakalamaz.)
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { ffmpeg, ffprobe } from '../../core/ffmpeg.js';
import { concatLine } from '../../core/files.js';
import { parameterSetMismatches, readParameterSets } from '../../core/h264.js';
import { createWorkspace } from '../../core/workspace.js';
import { prepareVideo } from '../../steps/01-video-prep.js';
import { assembleVideo, checkJunctions } from '../../steps/04-assemble.js';
import { countFrames, makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

describe('montaj güvenlik ağı', () => {
  let dir;
  let workspace;
  let base16;       // montaj varsayılanlarıyla (crf 16, slow) üretilmiş base
  let base22;       // farklı crf → kuyruk uyuşmaz
  let tone20;

  const makeBase = async (name, crf) => (await prepareVideo({
    clipPath: dir.path('clip.mp4'), outputPath: dir.path(name), workspace,
    cropBottom: 150, cropFromConfig: true, loopTest: false, crf,
  })).output;

  before(async () => {
    dir = await tempDir('assemble');
    workspace = await createWorkspace();
    await makeDriftingClip(dir.path('clip.mp4'));
    base16 = await makeBase('base16.mp4', 16);
    base22 = await makeBase('base22.mp4', 22);
    tone20 = await makeTone(dir.path('tone20.m4a'), { seconds: 20 });
  });

  after(async () => {
    await workspace?.cleanup();
    await dir?.cleanup();
  });

  describe('a) uyuşmayan kuyruk → tam encode', () => {
    let report;
    const warnings = [];

    before(async () => {
      report = await assembleVideo({
        videoPath: base22, audioPath: tone20, outputPath: dir.path('fallback.mp4'), workspace,
        logger: { info() {}, warn: (m) => warnings.push(m) },
      });
    });

    test('uyuşmazlık gerçekten oluştu ve adı konuldu', () => {
      assert.equal(report.tail.compatible, false);
      assert.match(report.tail.mismatch, /extradata/);
    });

    test('uyarı basıldı, yöntem full-encode', () => {
      assert.equal(report.method, 'full-encode');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Tam encode'a düşülüyor/);
      assert.deepEqual(report.warnings, warnings);
    });

    test('çıktı sağlam: kare sayısı, süre, biçim', async () => {
      assert.equal(await countFrames(report.output), 480);
      assert.ok(Math.abs(report.result.duration - 20) < 0.05, `süre ${report.result.duration}`);
      const { stdout } = await ffprobe([
        '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,profile', '-of', 'csv=p=0', report.output,
      ]);
      assert.equal(stdout.trim(), 'High,yuv420p');
    });

    test('tam encode çıktısında akış içi parametre seti uyuşmazlığı yok', async () => {
      assert.deepEqual(parameterSetMismatches(await readParameterSets(report.output)), []);
    });
  });

  describe('b) birleşme noktası kontrolü', () => {
    test('sağlam kopya montajı: iki nokta temiz', async () => {
      const r = await assembleVideo({
        videoPath: base16, audioPath: tone20, outputPath: dir.path('good.mp4'), workspace,
      });
      assert.equal(r.method, 'copy-body+encode-tail');
      assert.deepEqual(r.junctions.map((j) => [j.kind, j.clean]), [['klip→klip', true], ['gövde→kuyruk', true]]);
    });

    test('uyuşmayan dosya kopyayla zorla birleştirilirse yakalanır', async () => {
      // Korumayı atlayarak: gövde crf 16, üçüncü parça crf 22.
      const list = await workspace.writeText(
        'forced.txt', [base16, base16, base22].map(concatLine).join('\n') + '\n',
      );
      const forced = dir.path('forced.mp4');
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-y', forced]);

      // Önce: ffmpeg bu dosyayı hatasız çözüyor — eski kontrolün kör noktası.
      await ffmpeg(['-xerror', '-i', forced, '-f', 'null', '-']);

      const clipSeconds = 124 / 24;
      const results = await checkJunctions({
        path: forced,
        points: [
          { kind: 'klip→klip', seconds: clipSeconds },
          { kind: 'gövde→kuyruk', seconds: 2 * clipSeconds },
        ],
      });
      assert.equal(results[0].clean, true, results[0].error);
      assert.equal(results[1].clean, false);
      assert.match(results[1].error, /PPS 0 konteynerden farklı \(pic_init_qp_minus26/);
    });
  });

  describe('c) plan kenarları', () => {
    test('copies=0: 6 sn müzik → yalnızca kuyruk, birleşme noktası yok', async () => {
      const audio = await makeTone(dir.path('tone6.wav'), { seconds: 6, codec: 'pcm' });
      const r = await assembleVideo({
        videoPath: base16, audioPath: audio, outputPath: dir.path('short.mp4'), workspace,
      });
      assert.equal(r.plan.copies, 0);
      assert.equal(r.plan.tailFrames, 144);
      assert.equal(r.method, 'copy-body+encode-tail');
      assert.equal(r.result.frames, 144);
      assert.deepEqual(r.junctions, []);
    });

    test('tailFrames=0: fade yok, müzik klibin tam 2 katı → kuyruk encode edilmez', async () => {
      const audio = await makeTone(dir.path('tone248.wav'), { seconds: 248 / 24, codec: 'pcm' });
      const r = await assembleVideo({
        videoPath: base16, audioPath: audio, outputPath: dir.path('exact.mp4'), workspace, fadeOut: 0,
      });
      assert.equal(r.plan.copies, 2);
      assert.equal(r.plan.tailFrames, 0);
      assert.equal(r.tail, null);
      assert.equal(r.fade, null);
      assert.equal(r.result.frames, 248);
      assert.deepEqual(r.junctions.map((j) => [j.kind, j.clean]), [['klip→klip', true]]);
    });
  });
});
