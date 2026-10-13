/**
 * core/session-video.js — oturum başına görüntü kare planı (saf).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  distinctVisuals, MAIN_VISUAL_KEY, planSessionFrames, sessionJunctionPoints, visualKeyOf,
} from '../../core/session-video.js';

const FPS = 24;
/** Ad 'break' olan oturum kendi görüntüsünü ('break') kullanır; öbürleri ana görüntüyü (visual boş). */
const sessionOf = (name, startSeconds, endSeconds) => ({
  kind: 'status', name, visual: name === 'break' ? 'break' : null, startSeconds, endSeconds,
});
const sessions = (...bounds) => bounds.map(([name, start, end]) => sessionOf(name, start, end));

/** 1 dk çalışma + 1 dk mola × 2 tur. */
const TWO_ROUNDS = sessions(
  ['work', 0, 60], ['break', 60, 120], ['work', 120, 180], ['break', 180, 240],
);

describe('planSessionFrames', () => {
  it('oturumları ardışık, boşluksuz ve toplamı videoya eşit parçalara böler', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 120, break: 192 }, totalFrames: 240 * FPS,
    });

    assert.deepEqual(plan.parts.map((p) => p.visual), ['main', 'break', 'main', 'break']);
    assert.deepEqual(plan.parts.map((p) => p.startFrame), [0, 1440, 2880, 4320]);
    assert.deepEqual(plan.parts.map((p) => p.frames), [1440, 1440, 1440, 1440]);
    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), 240 * FPS);
  });

  it('her oturum kendi görüntüsünün tekrarına ve kuyruğuna bölünür', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 120, break: 192 }, totalFrames: 240 * FPS,
    });
    const [work, brk] = plan.parts;

    // 1440 = 12 × 120 (kuyruk yok); 1440 = 7 × 192 + 96.
    assert.deepEqual([work.clipFrames, work.copies, work.tailFrames], [120, 12, 0]);
    assert.deepEqual([brk.clipFrames, brk.copies, brk.tailFrames], [192, 7, 96]);
    for (const part of plan.parts) {
      assert.equal(part.copies * part.clipFrames + part.tailFrames, part.frames);
    }
  });

  it('fade yalnızca son oturumun kuyruğuna girer ve kuyruk fade\'i kapsar', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 120, break: 192 }, totalFrames: 240 * FPS, fadeFrames: 120,
    });

    assert.deepEqual(plan.parts.map((p) => p.fadeFrames), [0, 0, 0, 120]);
    assert.equal(plan.fadeFrames, 120);
    const last = plan.parts[3];
    assert.ok(last.tailFrames >= last.fadeFrames, 'kuyruk fade\'i taşıyamıyor');
  });

  it('ardışık toplamdan yuvarlar: 48 oturumda kare kaymaz', () => {
    // 23.976 fps: 600 sn × 23.976 tam sayı değil; her oturumu ayrı yuvarlamak kayardı.
    const fps = 23.976;
    const many = [];
    for (let i = 0; i < 24; i++) {
      many.push(sessionOf('work', i * 1200, i * 1200 + 600));
      many.push(sessionOf('break', i * 1200 + 600, (i + 1) * 1200));
    }
    const total = Math.round(28800 * fps);
    const plan = planSessionFrames({ sessions: many, fps, clipFrames: { main: 144, break: 144 }, totalFrames: total });

    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), total);
    assert.equal(plan.parts[1].startFrame, Math.round(600 * fps));
    assert.equal(plan.parts[47].startFrame, Math.round(many[47].startSeconds * fps));
  });

  it('son oturum sesin sonuna kadar uzar (müzik timeline\'dan toleransla uzunsa)', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 120, break: 120 }, totalFrames: 240 * FPS + 10,
    });
    assert.equal(plan.parts[3].frames, 1440 + 10);
    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), 240 * FPS + 10);
  });

  it('oturum döngüden kısaysa tamamı kuyruktur', () => {
    const plan = planSessionFrames({
      sessions: sessions(['work', 0, 2], ['break', 2, 4]), fps: FPS, clipFrames: { main: 480, break: 480 }, totalFrames: 96,
    });
    assert.deepEqual(plan.parts.map((p) => [p.copies, p.tailFrames]), [[0, 48], [0, 48]]);
  });

  it('bozuk girdide anlaşılır hata verir', () => {
    assert.throws(
      () => planSessionFrames({ sessions: [], fps: FPS, clipFrames: { main: 1, break: 1 }, totalFrames: 10 }),
      /en az bir oturum/,
    );
    assert.throws(
      () => planSessionFrames({ sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 0, break: 1 }, totalFrames: 10 }),
      /Geçersiz görüntü \(main\)/,
    );
    // Ses timeline'dan çok kısa: sonraki oturumlara kare kalmaz.
    assert.throws(
      () => planSessionFrames({ sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 24, break: 24 }, totalFrames: 100 }),
      /kare kalmadı/,
    );
  });
});

describe('GET READY oturumu', () => {
  const withReady = [
    { kind: 'ready', name: 'GET READY', visual: null, startSeconds: 0, endSeconds: 120 },
    ...sessions(['work', 120, 180], ['break', 180, 240]),
  ];

  it('görüntüsü verilmemişse ana görüntüyü kullanır ama oturum türü ready kalır', () => {
    const plan = planSessionFrames({
      sessions: withReady, fps: FPS, clipFrames: { main: 120, break: 192 }, totalFrames: 240 * FPS,
    });
    assert.deepEqual(plan.parts.map((p) => [p.kind, p.visual]), [['ready', 'main'], ['status', 'main'], ['status', 'break']]);
    // 120 sn = 2880 kare = 24 × 120 (çalışma döngüsüyle tam bölünür).
    assert.deepEqual([plan.parts[0].frames, plan.parts[0].copies, plan.parts[0].tailFrames], [2880, 24, 0]);
  });
});

describe('özel durum görüntüleri', () => {
  const stretch = sessions(['study', 0, 60], ['esneme', 60, 90], ['break', 90, 150]);
  stretch[1].visual = 'esneme';

  it('her durum kendi görüntüsünün karesini kullanır; anahtar yoksa ana görüntü', () => {
    const plan = planSessionFrames({
      sessions: [{ kind: 'ready', name: 'GET READY', visual: 'hazir', startSeconds: 0, endSeconds: 10 }, ...stretch.map((x) => ({
        ...x, startSeconds: x.startSeconds + 10, endSeconds: x.endSeconds + 10,
      }))],
      fps: FPS,
      clipFrames: { main: 120, break: 96, esneme: 72, hazir: 48 },
      totalFrames: 160 * FPS,
    });
    assert.deepEqual(plan.parts.map((p) => p.visual), ['hazir', 'main', 'esneme', 'break']);
    assert.deepEqual(plan.parts.map((p) => p.clipFrames), [48, 120, 72, 96]);
    for (const part of plan.parts) assert.equal(part.copies * part.clipFrames + part.tailFrames, part.frames);
  });

  it('hazırlanmamış görüntü anlaşılır hata verir', () => {
    assert.throws(
      () => planSessionFrames({ sessions: stretch, fps: FPS, clipFrames: { main: 24, break: 24 }, totalFrames: 150 * FPS }),
      /hazırlanmamış: esneme/,
    );
  });

  it('visualKeyOf boş görüntüyü ana görüntü anahtarına çevirir', () => {
    assert.equal(visualKeyOf({ visual: null }), MAIN_VISUAL_KEY);
    assert.equal(visualKeyOf({}), MAIN_VISUAL_KEY);
    assert.equal(visualKeyOf({ visual: 'C:/a.png' }), 'C:/a.png');
  });

  it('distinctVisuals ana klibin kendisini listeye almaz', () => {
    const plan = {
      intro: { visual: null, visualSource: null },
      statuses: [
        { visual: 'C:/ana.mp4', visualSource: 'clip' },
        { visual: 'C:/mola.png', visualSource: 'image' },
      ],
    };
    assert.deepEqual(distinctVisuals(plan, 'C:/ana.mp4'), [{ path: 'C:/mola.png', source: 'image' }]);
    assert.equal(distinctVisuals(plan).length, 2);
  });

  it('distinctVisuals aynı dosyayı bir kez, ana görüntüye düşenleri hiç saymaz', () => {
    assert.deepEqual(distinctVisuals(null), []);
    const plan = {
      intro: { visual: 'C:/hazir.png', visualSource: 'image' },
      statuses: [
        { visual: null, visualSource: null },
        { visual: 'C:/mola.mp4', visualSource: 'clip' },
        { visual: 'C:/hazir.png', visualSource: 'image' },
      ],
    };
    assert.deepEqual(distinctVisuals(plan), [
      { path: 'C:/hazir.png', source: 'image' },
      { path: 'C:/mola.mp4', source: 'clip' },
    ]);
  });
});

describe('sessionJunctionPoints', () => {
  it('her oturum geçişini, gövde→kuyruk dikişini ve ilk klip→klip dikişini içerir', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { main: 120, break: 192 }, totalFrames: 240 * FPS,
    });
    const points = sessionJunctionPoints(plan);

    assert.deepEqual(points.filter((p) => p.kind === 'oturum geçişi').map((p) => p.seconds), [60, 120, 180]);
    assert.equal(points.filter((p) => p.kind === 'klip→klip').length, 1);
    // Yalnızca mola oturumlarında kuyruk var (7 × 192 = 1344 kare = 56 sn).
    assert.deepEqual(
      points.filter((p) => p.kind === 'gövde→kuyruk').map((p) => p.seconds),
      [116, 236],
    );
  });
});
