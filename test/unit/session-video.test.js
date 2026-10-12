/**
 * core/session-video.js — oturum başına görüntü kare planı (saf).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planSessionFrames, sessionJunctionPoints } from '../../core/session-video.js';

const FPS = 24;
const sessions = (...bounds) => bounds.map(([kind, startSeconds, endSeconds]) => ({ kind, startSeconds, endSeconds }));

/** 1 dk çalışma + 1 dk mola × 2 tur. */
const TWO_ROUNDS = sessions(
  ['work', 0, 60], ['break', 60, 120], ['work', 120, 180], ['break', 180, 240],
);

describe('planSessionFrames', () => {
  it('oturumları ardışık, boşluksuz ve toplamı videoya eşit parçalara böler', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 120, break: 192 }, totalFrames: 240 * FPS,
    });

    assert.deepEqual(plan.parts.map((p) => p.kind), ['work', 'break', 'work', 'break']);
    assert.deepEqual(plan.parts.map((p) => p.startFrame), [0, 1440, 2880, 4320]);
    assert.deepEqual(plan.parts.map((p) => p.frames), [1440, 1440, 1440, 1440]);
    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), 240 * FPS);
  });

  it('her oturum kendi görüntüsünün tekrarına ve kuyruğuna bölünür', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 120, break: 192 }, totalFrames: 240 * FPS,
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
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 120, break: 192 }, totalFrames: 240 * FPS, fadeFrames: 120,
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
      many.push({ kind: 'work', startSeconds: i * 1200, endSeconds: i * 1200 + 600 });
      many.push({ kind: 'break', startSeconds: i * 1200 + 600, endSeconds: (i + 1) * 1200 });
    }
    const total = Math.round(28800 * fps);
    const plan = planSessionFrames({ sessions: many, fps, clipFrames: { work: 144, break: 144 }, totalFrames: total });

    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), total);
    assert.equal(plan.parts[1].startFrame, Math.round(600 * fps));
    assert.equal(plan.parts[47].startFrame, Math.round(many[47].startSeconds * fps));
  });

  it('son oturum sesin sonuna kadar uzar (müzik timeline\'dan toleransla uzunsa)', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 120, break: 120 }, totalFrames: 240 * FPS + 10,
    });
    assert.equal(plan.parts[3].frames, 1440 + 10);
    assert.equal(plan.parts.reduce((sum, p) => sum + p.frames, 0), 240 * FPS + 10);
  });

  it('oturum döngüden kısaysa tamamı kuyruktur', () => {
    const plan = planSessionFrames({
      sessions: sessions(['work', 0, 2], ['break', 2, 4]), fps: FPS, clipFrames: { work: 480, break: 480 }, totalFrames: 96,
    });
    assert.deepEqual(plan.parts.map((p) => [p.copies, p.tailFrames]), [[0, 48], [0, 48]]);
  });

  it('bozuk girdide anlaşılır hata verir', () => {
    assert.throws(
      () => planSessionFrames({ sessions: [], fps: FPS, clipFrames: { work: 1, break: 1 }, totalFrames: 10 }),
      /en az bir oturum/,
    );
    assert.throws(
      () => planSessionFrames({ sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 0, break: 1 }, totalFrames: 10 }),
      /work görüntüsü/,
    );
    // Ses timeline'dan çok kısa: sonraki oturumlara kare kalmaz.
    assert.throws(
      () => planSessionFrames({ sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 24, break: 24 }, totalFrames: 100 }),
      /kare kalmadı/,
    );
  });
});

describe('sessionJunctionPoints', () => {
  it('her oturum geçişini, gövde→kuyruk dikişini ve ilk klip→klip dikişini içerir', () => {
    const plan = planSessionFrames({
      sessions: TWO_ROUNDS, fps: FPS, clipFrames: { work: 120, break: 192 }, totalFrames: 240 * FPS,
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
