import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeFilename } from '../../core/files.js';

test('sanitizeFilename - geçersiz karakterleri temizler, boşluğu tire yapar', () => {
  assert.equal(sanitizeFilename('Chill / Lofi: Song?'), 'Chill-Lofi-Song');
  assert.equal(sanitizeFilename('   Multiple   Spaces   '), 'Multiple-Spaces');
});

test('sanitizeFilename - boş ya da yalnızca geçersiz karakterse untitled', () => {
  assert.equal(sanitizeFilename('***'), 'untitled');
  assert.equal(sanitizeFilename(''), 'untitled');
  assert.equal(sanitizeFilename(undefined), 'untitled');
});
