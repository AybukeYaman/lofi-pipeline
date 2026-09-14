/**
 * Ses birleştirmenin saf parçaları: girdi dalı, süre toleransı.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DURATION_TOLERANCE, durationsMatch } from '../../core/probe.js';
import { normalizeBranch } from '../../steps/02-audio-concat.js';

test('mono girdi pan ile çoğaltılır (aformat 3 dB düşürüyor)', () => {
  assert.equal(
    normalizeBranch(0, { channels: 1 }),
    '[0:a]aresample=48000,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a0]',
  );
});

test('stereo ve çok kanallı girdi yalnızca aformat ile', () => {
  for (const channels of [2, 6, null]) {
    const branch = normalizeBranch(3, { channels });
    assert.ok(!branch.includes('pan='), `${channels} kanal: ${branch}`);
    assert.match(branch, /^\[3:a\]aresample=48000,aformat=.*channel_layouts=stereo\[a3\]$/);
  }
});

test('süre toleransı 0.05 sn', () => {
  assert.equal(DURATION_TOLERANCE, 0.05);
  assert.ok(durationsMatch(2885.7, 2885.708496));
  assert.ok(durationsMatch(10, 10.049));
  assert.ok(!durationsMatch(10, 10.051));
  // Eski yolların gizlediği kayma artık görünür.
  assert.ok(!durationsMatch(150.021, 150.395));
  assert.ok(!durationsMatch(2885.68, 2885.8825));
});

test('geçersiz süre eşleşmez', () => {
  assert.ok(!durationsMatch(null, 10));
  assert.ok(!durationsMatch(10, NaN));
});
