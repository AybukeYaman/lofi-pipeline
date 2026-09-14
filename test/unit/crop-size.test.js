/**
 * checkCropHeight / planAspectCrop — tek sayılı boyutlar (saf hesap).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CropSizeError, checkCropHeight, planAspectCrop } from '../../steps/01-video-prep.js';

test('çift sonuç → geçer', () => {
  assert.doesNotThrow(() => checkCropHeight({ height: 1248, cropBottom: 150 }));
  assert.doesNotThrow(() => checkCropHeight({ height: 1248, cropBottom: 0 }));
});

test('tek sonuç → CropSizeError, değer değişmez, komşular önerilir', () => {
  assert.throws(
    () => checkCropHeight({ height: 1248, cropBottom: 151 }),
    (e) => e instanceof CropSizeError
      && e.cropBottom === 151
      && e.suggestions.join() === '150,152'
      && /150 ya da 152 kullan/.test(e.message)
      && /1097/.test(e.message),
  );
});

test('öneri sınırda: 0 altına ve klip yüksekliğine inilmez', () => {
  assert.throws(
    () => checkCropHeight({ height: 1249, cropBottom: 0 }),
    (e) => e instanceof CropSizeError && e.suggestions.join() === '1',
  );
});

test('Hailuo 2944×1098: iki yan eşit, 496/496 (değişmedi)', () => {
  const p = planAspectCrop({ width: 2944, height: 1098, aspect: '16:9' });
  assert.equal(p.filter, 'crop=1952:1098:496:0');
  assert.deepEqual([p.left, p.right], [496, 496]);
});

test('sol kesim her zaman çift (ffmpeg yuv420p\'de x\'i çifte indiriyor)', () => {
  for (const [width, height] of [[2946, 1098], [2944, 1096], [2945, 1248], [3001, 1080], [2000, 1000]]) {
    const p = planAspectCrop({ width, height, aspect: '16:9' });
    assert.equal(p.left % 2, 0, `${width}×${height}: sol ${p.left}`);
    assert.equal(p.after.width % 2, 0, `${width}×${height}: genişlik ${p.after.width}`);
    assert.equal(p.left + p.after.width + p.right, width);
    assert.ok(p.right - p.left >= 0 && p.right - p.left <= 3, `${width}×${height}: ${p.left}/${p.right}`);
  }
});

test('fark 4\'e bölünmüyorsa sağ 2 px fazla: 2946 → 496/498', () => {
  const p = planAspectCrop({ width: 2946, height: 1098, aspect: '16:9' });
  assert.deepEqual([p.left, p.right], [496, 498]);
});
