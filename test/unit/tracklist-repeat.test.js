/**
 * steps/05-tracklist.js — kısa Pomodoro müziğinde baştan tekrar çalan parçalar
 * tracklist'te kendi zaman damgasıyla ve " (tekrar)" ekiyle yeniden yazılır.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REPEAT_SUFFIX, buildTracklist } from '../../steps/05-tracklist.js';

describe('buildTracklist — tekrar çalan parçalar', () => {
  it('tekrar eden parça kendi damgasıyla ve (tekrar) ekiyle yazılır', () => {
    const { text, entries } = buildTracklist([
      { file: 'audio/Amber Curtains.m4a', startSeconds: 0, duration: 1200 },
      { file: 'audio/Rainy Window.m4a', startSeconds: 1200, duration: 1200 },
      { file: 'audio/Amber Curtains.m4a', startSeconds: 2400, duration: 600, repeat: true },
    ]);
    assert.equal(REPEAT_SUFFIX, ' (tekrar)');
    assert.deepEqual(entries.map((e) => e.name), ['Amber Curtains', 'Rainy Window', 'Amber Curtains (tekrar)']);
    assert.match(text, /40:00 {2}Amber Curtains \(tekrar\)\n$/);
  });
});
