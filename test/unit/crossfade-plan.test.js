/**
 * planCrossfade — saf hesap (ffmpeg yok).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planCrossfade } from '../../steps/01-video-prep.js';

test('Hailuo klibi (124 kare, 24 fps), 1 sn crossfade', () => {
  const p = planCrossfade({ duration: 124 / 24, fps: 24, crossfadeSeconds: 1 });
  assert.equal(p.sourceFrames, 124);
  assert.equal(p.fadeFrames, 24);
  assert.equal(p.blendFrames, 23);
  // Çıktı: [24, 124) = 100 kare, sonuna saf orig 23 → 101
  assert.equal(p.outputFrames, 101);
  // Gövde 100 kare, son 23'ü karışır → karışım 77. karede başlar
  assert.equal(p.offsetSeconds, 77 / 24);
  assert.equal(p.blendSeconds, 23 / 24);
});

test('saniye kare sınırına yuvarlanır', () => {
  const p = planCrossfade({ duration: 5.166667, fps: 24, crossfadeSeconds: 0.51 });
  assert.equal(p.sourceFrames, 124);
  assert.equal(p.fadeFrames, 12);
  assert.equal(p.outputFrames, 113);
});

test('en uzun geçerli değer: 2C−1 = N', () => {
  const p = planCrossfade({ duration: 125 / 25, fps: 25, crossfadeSeconds: 63 / 25 });
  assert.equal(p.fadeFrames, 63);
  assert.equal(p.offsetSeconds, 0);
  assert.equal(p.outputFrames, 63);
});

test('klibin yarısından uzun → hata', () => {
  assert.throws(
    () => planCrossfade({ duration: 124 / 24, fps: 24, crossfadeSeconds: 3 }),
    /yarısından uzun/,
  );
});

test('iki kareden kısa → hata', () => {
  assert.throws(
    () => planCrossfade({ duration: 5, fps: 24, crossfadeSeconds: 0.05 }),
    /en az iki kare/,
  );
});

test('kare hızı yok → hata', () => {
  assert.throws(() => planCrossfade({ duration: 5, fps: null, crossfadeSeconds: 1 }), /kare hızı/);
});
