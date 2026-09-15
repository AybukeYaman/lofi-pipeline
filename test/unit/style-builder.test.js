import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStylePrompt } from '../../prep/style-builder.js';
import { StyleBuildError } from '../../prep/style-errors.js';

test('buildStylePrompt - geçerli tam obje ile sıralı birleştirme (genre -> instruments -> mood -> vocal -> production)', () => {
  const style = {
    name: 'chill-lofi',
    genre: 'lo-fi hip hop',
    instruments: ['rhodes keyboard', 'dusted drums', 'soft bass'],
    mood: ['chill', 'mellow', 'relaxing'],
    vocal: 'instrumental',
    production: ['vinyl crackle', 'warm tape saturation'],
    exclude: ['vocals', 'heavy distortion'],
  };

  const expected =
    'lo-fi hip hop, rhodes keyboard, dusted drums, soft bass, chill, mellow, relaxing, instrumental, vinyl crackle, warm tape saturation';
  assert.equal(buildStylePrompt(style), expected);
});

test('buildStylePrompt - eksik veya boş alanların atlanması (skip)', () => {
  const style = {
    genre: 'ambient lofi',
    mood: ['calm'],
  };
  assert.equal(buildStylePrompt(style), 'ambient lofi, calm');
});

test('buildStylePrompt - duplicate ve boşluk temizliğinin doğrulanması', () => {
  const style = {
    genre: 'lo-fi hip hop',
    instruments: ['rhodes keyboard', 'Lo-Fi Hip Hop'],
    mood: ['chill', 'chill'],
  };
  assert.equal(buildStylePrompt(style), 'lo-fi hip hop, rhodes keyboard, chill');
});

test('buildStylePrompt - geçersiz/boş girdilerde StyleBuildError fırlatılması', () => {
  assert.throws(
    () => buildStylePrompt(null),
    (err) => err instanceof StyleBuildError && err.message.includes('Stil girdisi geçerli bir nesne olmalı')
  );

  assert.throws(
    () => buildStylePrompt([]),
    (err) => err instanceof StyleBuildError && err.message.includes('Stil girdisi geçerli bir nesne olmalı')
  );

  assert.throws(
    () => buildStylePrompt({ name: 'empty-style' }),
    (err) => err instanceof StyleBuildError && err.message.includes('geçerli bir Suno Style dizesi üretilemedi')
  );
});
