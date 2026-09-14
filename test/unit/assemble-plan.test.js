/**
 * planFrames / junctionPoints — saf hesap.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { junctionPoints, planFrames } from '../../steps/04-assemble.js';

test('gerçek albüm: 2885.7 sn, 124 karelik klip, 5 sn fade', () => {
  const p = planFrames({ clipDuration: 124 / 24, fps: 24, targetDuration: 2885.7, fadeOut: 5 });
  assert.deepEqual(
    [p.totalFrames, p.clipFrames, p.copies, p.tailFrames, p.fadeFrames],
    [69257, 124, 557, 189, 120],
  );
  assert.equal(p.copies * p.clipFrames + p.tailFrames, p.totalFrames);
  assert.deepEqual(junctionPoints(p).map((j) => j.kind), ['klip→klip', 'gövde→kuyruk']);
});

test('copies=0: müzik klip + fade\'den kısa → her şey kuyruk', () => {
  const p = planFrames({ clipDuration: 124 / 24, fps: 24, targetDuration: 6, fadeOut: 5 });
  assert.equal(p.copies, 0);
  assert.equal(p.tailFrames, 144);
  assert.equal(p.tailStartSeconds, 0);
  assert.deepEqual(junctionPoints(p), []);
});

test('tailFrames=0: fade yok ve müzik klibin tam katı', () => {
  const p = planFrames({ clipDuration: 124 / 24, fps: 24, targetDuration: 248 / 24, fadeOut: 0 });
  assert.equal(p.copies, 2);
  assert.equal(p.tailFrames, 0);
  assert.deepEqual(junctionPoints(p).map((j) => j.kind), ['klip→klip']);
});

test('kuyruk her zaman fade\'in tamamını içerir', () => {
  for (const target of [10, 10.4, 15.5, 30, 61.2]) {
    const p = planFrames({ clipDuration: 124 / 24, fps: 24, targetDuration: target, fadeOut: 5 });
    assert.ok(p.tailFrames >= p.fadeFrames, `${target} sn: kuyruk ${p.tailFrames} < fade ${p.fadeFrames}`);
    assert.ok(p.tailFrames < p.fadeFrames + p.clipFrames, `${target} sn: kuyruk bir klipten uzun`);
  }
});

test('fade müzikten uzunsa müzik süresine kırpılır', () => {
  const p = planFrames({ clipDuration: 124 / 24, fps: 24, targetDuration: 3, fadeOut: 5 });
  assert.equal(p.fadeFrames, 72);
  assert.equal(p.tailFrames, 72);
});

test('geçersiz süre → hata', () => {
  assert.throws(() => planFrames({ clipDuration: 0, fps: 24, targetDuration: 10, fadeOut: 5 }), /Geçersiz/);
  assert.throws(() => planFrames({ clipDuration: 5, fps: 24, targetDuration: 0, fadeOut: 5 }), /Geçersiz/);
});
