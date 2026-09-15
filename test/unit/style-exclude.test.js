import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildExcludePrompt } from '../../prep/style-exclude.js';
import { StyleBuildError } from '../../prep/style-errors.js';

test('buildExcludePrompt - boş ve geçersiz girdiler', () => {
  assert.equal(buildExcludePrompt(null), '');
  assert.equal(buildExcludePrompt(undefined), '');
  assert.equal(buildExcludePrompt({}), '');
  assert.equal(buildExcludePrompt({ exclude: [] }), '');
});

test('buildExcludePrompt - diziden exclude prompt üretimi', () => {
  assert.equal(buildExcludePrompt(['vocals', 'heavy distortion', 'fast tempo']), 'vocals, heavy distortion, fast tempo');
});

test('buildExcludePrompt - obje içerisindeki exclude alanından üretim', () => {
  const styleObj = {
    name: 'test-style',
    exclude: ['vocals', 'noise', 'vocals'],
  };
  assert.equal(buildExcludePrompt(styleObj), 'vocals, noise');
});

test('buildExcludePrompt - string exclude alanı ve duplicate temizliği', () => {
  assert.equal(buildExcludePrompt('vocals, distortion, Vocals'), 'vocals, distortion');
});

test('buildExcludePrompt - hatalı exclude tipi StyleBuildError fırlatır', () => {
  assert.throws(
    () => buildExcludePrompt({ exclude: 12345 }),
    (err) => err instanceof StyleBuildError && err.message.includes('exclude alanı bir dizi veya metin olmalı')
  );

  assert.throws(
    () => buildExcludePrompt(12345),
    (err) => err instanceof StyleBuildError && err.message.includes('Exclude girdisi bir dizi, obje veya metin olmalı')
  );
});
