/**
 * Etiket katmanının gerçek ffmpeg'le doğrulaması.
 *
 *   a) Konum: etiketin merkezi `x,y` oranında görünür (önizleme formülü bununla birebir),
 *      kenara taşmaz.
 *   b) Pomodoro: STUDY/BREAK yalnızca kendi aralığında değişir, geri sayım akar;
 *      konumu değiştirmek zamanı değiştirmez.
 *   c) Montaj: etiket yoksa eski hızlı yol (gövde kopya) aynen kalır; etiket varsa
 *      tam encode ve çıktıda yazı görünür.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { buildLabelFilter } from '../../core/label-filter.js';
import { normalizeLabelPlan } from '../../core/label-plan.js';
import { createWorkspace } from '../../core/workspace.js';
import { prepareVideo } from '../../steps/01-video-prep.js';
import { assembleVideo } from '../../steps/04-assemble.js';
import { DEFAULT_LABEL_FONT_FILE, prepareLabelOverlay } from '../../steps/04a-label-overlay.js';
import { countFrames, extractFrame, makeDriftingClip, makeTone, ssim, tempDir } from '../helpers/fixtures.js';

const W = 320;
const H = 180;
const SESSIONS = [
  { kind: 'status', name: 'STUDY', startSeconds: 0, endSeconds: 2 },
  { kind: 'status', name: 'BREAK', startSeconds: 2, endSeconds: 4 },
];

let hasFont = true;
try { await access(DEFAULT_LABEL_FONT_FILE); } catch { hasFont = false; }
const maybe = hasFont ? describe : describe.skip;

maybe('etiket katmanı (gerçek ffmpeg)', () => {
  let dir;
  let workspace;

  before(async () => {
    dir = await tempDir('labels');
    workspace = await createWorkspace();
  });
  after(async () => {
    await workspace?.cleanup();
    await dir?.cleanup();
  });

  /** Siyah 320×180 videoya etiketleri yakar, `at` saniyesindeki gri kareyi döner. */
  async function renderGray(rawLabels, at, { sessions = null } = {}) {
    const { labels } = normalizeLabelPlan(rawLabels);
    const built = buildLabelFilter({
      labels, height: H, fontFile: DEFAULT_LABEL_FONT_FILE, sessions,
      textPath: (name) => dir.path(name),
    });
    for (const file of built.files) await writeFile(dir.path(file.name), file.content, 'utf8');
    const run = spawnSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=5:r=10`,
      '-vf', built.filter, '-ss', String(at), '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { encoding: 'buffer', maxBuffer: 10_000_000 });
    assert.equal(run.status, 0, run.stderr.toString());
    assert.equal(run.stdout.length, W * H);
    return run.stdout;
  }

  /** Parlak piksellerin ağırlık merkezi ve sınırları. */
  function bright(frame, threshold = 128) {
    let sx = 0; let sy = 0; let n = 0;
    let minX = W; let maxX = -1; let minY = H; let maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (frame[y * W + x] <= threshold) continue;
        sx += x; sy += y; n++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    return { n, cx: n ? sx / n : NaN, cy: n ? sy / n : NaN, minX, maxX, minY, maxY };
  }

  describe('a) konum', () => {
    test('etiketin MERKEZİ x,y oranında: sol-üst, sağ-alt ve orta', async () => {
      for (const [x, y] of [[0.25, 0.25], [0.75, 0.8], [0.5, 0.5]]) {
        const b = bright(await renderGray([{ id: 'a', text: 'MMMM', x, y, size: 0.15 }], 1));
        assert.ok(b.n > 50, `yazı görünmüyor (${x},${y})`);
        assert.ok(Math.abs(b.cx - x * W) <= 6, `cx ${b.cx} ≠ ${x * W}`);
        assert.ok(Math.abs(b.cy - y * H) <= 6, `cy ${b.cy} ≠ ${y * H}`);
      }
    });

    test('köşeye (0,0) ve (1,1) konsa da yazı kenardan taşmaz', async () => {
      const topLeft = bright(await renderGray([{ id: 'a', text: 'MMMM', x: 0, y: 0, size: 0.15 }], 1));
      assert.ok(topLeft.minX >= 0 && topLeft.minY >= 0);
      assert.ok(topLeft.maxX < W / 2 && topLeft.maxY < H / 2, 'yazı tam görünür kalmalı');
      const bottomRight = bright(await renderGray([{ id: 'a', text: 'MMMM', x: 1, y: 1, size: 0.15 }], 1));
      assert.ok(bottomRight.minX > W / 2 && bottomRight.minY > H / 2);
      assert.ok(bottomRight.maxX <= W - 1 && bottomRight.maxY <= H - 1);
    });

    test('aralıklı metin yalnızca aralığında görünür', async () => {
      const label = [{ id: 'a', text: 'MMMM', start: 2, end: 3 }];
      assert.equal(bright(await renderGray(label, 1)).n, 0);
      assert.ok(bright(await renderGray(label, 2.5)).n > 50);
      assert.equal(bright(await renderGray(label, 4)).n, 0);
    });
  });

  describe('b) Pomodoro etiketleri', () => {
    const status = (x, y) => [{ id: 's', kind: 'pomodoro-status', x, y, size: 0.15 }];

    test('STUDY → BREAK geçişi oturum sınırında olur, konum bunu değiştirmez', async () => {
      for (const [x, y] of [[0.8, 0.15], [0.2, 0.85]]) {
        const study1 = await renderGray(status(x, y), 0.5, { sessions: SESSIONS });
        const study2 = await renderGray(status(x, y), 1.5, { sessions: SESSIONS });
        const breakFrame = await renderGray(status(x, y), 2.5, { sessions: SESSIONS });
        assert.ok(study1.equals(study2), 'aynı oturumda yazı aynı kalır');
        assert.ok(!study1.equals(breakFrame), 'oturum değişince yazı değişir');
        const b = bright(breakFrame);
        assert.ok(Math.abs(b.cx - x * W) <= 8 && Math.abs(b.cy - y * H) <= 8, 'yazı seçilen yerde');
      }
    });

    test('geri sayım her saniye akar; oturum içinde azalır', async () => {
      const countdown = [{ id: 'c', kind: 'pomodoro-countdown', x: 0.5, y: 0.5, size: 0.2 }];
      const early = await renderGray(countdown, 0.2, { sessions: SESSIONS });
      const later = await renderGray(countdown, 1.2, { sessions: SESSIONS });
      assert.ok(bright(early).n > 30);
      assert.ok(!early.equals(later), 'sayaç değişmedi');
    });

    test('Pomodoro kapalıyken sistem etiketi yok sayılır (kare boş)', async () => {
      const { labels } = normalizeLabelPlan(status(0.5, 0.5));
      const built = buildLabelFilter({
        labels, height: H, fontFile: DEFAULT_LABEL_FONT_FILE, sessions: null, textPath: (n) => dir.path(n),
      });
      assert.equal(built.filter, null);
      assert.equal(built.skipped.length, 1);
    });
  });

  describe('c) montaj', () => {
    let base;
    let tone;
    let plain;
    let labelled;

    before(async () => {
      await makeDriftingClip(dir.path('clip.mp4'));
      base = (await prepareVideo({
        clipPath: dir.path('clip.mp4'), outputPath: dir.path('base.mp4'), workspace,
        cropBottom: 150, cropFromConfig: true, loopTest: false, crf: 16,
      })).output;
      tone = await makeTone(dir.path('tone.m4a'), { seconds: 20 });

      plain = await assembleVideo({
        videoPath: base, audioPath: tone, outputPath: dir.path('plain.mp4'), workspace,
      });
      const overlay = await prepareLabelOverlay({
        labels: normalizeLabelPlan([{ id: 'a', text: 'ETIKET', x: 0.5, y: 0.5, size: 0.2 }]).labels,
        videoPath: base, workspace,
      });
      labelled = await assembleVideo({
        videoPath: base, audioPath: tone, outputPath: dir.path('labelled.mp4'), workspace,
        overlayFilter: overlay.filter,
      });
    });

    test('etiket yokken eski hızlı yol aynen: gövde kopya + kuyruk encode', () => {
      assert.equal(plain.method, 'copy-body+encode-tail');
      assert.equal(plain.labels, false);
    });

    test('etiket varken tam encode; kare sayısı, süre ve çözünürlük korunur', async () => {
      assert.equal(labelled.method, 'full-encode');
      assert.equal(labelled.labels, true);
      assert.equal(await countFrames(labelled.output), await countFrames(plain.output));
      assert.ok(Math.abs(labelled.result.duration - plain.result.duration) < 0.05);
      assert.equal(labelled.result.width, plain.result.width);
      assert.equal(labelled.result.height, plain.result.height);
    });

    test('etiketli çıktıda yazı görünür, etiketsizde görünmez', async () => {
      await extractFrame(plain.output, 100, dir.path('p.png'));
      await extractFrame(labelled.output, 100, dir.path('l.png'));
      const similarity = await ssim(dir.path('p.png'), dir.path('l.png'));
      assert.ok(similarity < 0.99, `kareler aynı görünüyor (SSIM ${similarity})`);
    });

    test('font yoksa açık hata verir (sessizce etiketsiz üretmez)', async () => {
      await assert.rejects(
        prepareLabelOverlay({
          labels: normalizeLabelPlan([{ id: 'a', text: 'x' }]).labels,
          videoPath: base, workspace, fontFile: 'C:/yok/yok.ttf',
        }),
        /yazı tipi bulunamadı/,
      );
    });

    test('etiket listesi boşsa hazırlık null döner (montaj eski yolda kalır)', async () => {
      const result = await prepareLabelOverlay({ labels: [], videoPath: base, workspace });
      assert.equal(result.filter, null);
    });
  });
});
