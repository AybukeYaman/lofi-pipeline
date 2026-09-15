import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanStyleString } from '../../prep/style-cleaner.js';

test('cleanStyleString - boş ve geçersiz girdiler', () => {
  assert.equal(cleanStyleString(null), '');
  assert.equal(cleanStyleString(undefined), '');
  assert.equal(cleanStyleString(123), '');
  assert.equal(cleanStyleString(''), '');
});

test('cleanStyleString - fazla boşluk ve virgül temizliği', () => {
  assert.equal(cleanStyleString('  lo-fi   hip hop , , chill '), 'lo-fi hip hop, chill');
});

test('cleanStyleString - mükerrer (case-insensitive) etiket temizliği', () => {
  assert.equal(cleanStyleString('chill, Chill, CHILL, mellow'), 'chill, mellow');
  assert.equal(cleanStyleString('lo-fi hip hop, rhodes, lo-fi hip hop'), 'lo-fi hip hop, rhodes');
});
