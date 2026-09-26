/**
 * prep/styles.js — müzik stili şeması ve doğrulama.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import {
  MUSIC_FIELDS, StyleError, hasMusicProfile, listStyles, loadStyle, musicStyleText, validateStyle,
} from '../../prep/styles.js';
import { tempDir } from '../helpers/fixtures.js';

const AMBIENTS = ['campfire', 'gentleRain'].map((name) => ({ name, path: `X:\\ambient\\${name}.mp3` }));
const MUSIC = {
  genre: 'lofi hip hop',
  production: ['tape saturation', 'vinyl crackle'],
  instruments: ['Rhodes'],
  aesthetic: 'rainy night',
  exclude: ['vocals'],
};

describe('repodaki stiller', () => {
  test('hepsi geçerli ve BOM\'suz; eski görsel alanlar uyarı vermez', async () => {
    const names = await listStyles();
    assert.ok(names.length > 0);
    for (const name of names) {
      const { warnings, path } = await loadStyle(name);
      assert.deepEqual(warnings, [], name);
      const bytes = await readFile(path);
      assert.notEqual(bytes[0], 0xef, `${name} BOM'lu`);
    }
  });
});

describe('validateStyle', () => {
  test('yalnızca ad geçerli (müzik profili isteğe bağlı)', () => {
    assert.deepEqual(validateStyle({ name: 'bos-profil' }), { problems: [], warnings: [] });
  });

  test('müzik profili, ambient önerisi ve eski görsel alanlar birlikte geçerli', () => {
    const r = validateStyle(
      { name: 'x', music: MUSIC, suggestedAmbient: 'campfire', styleBlock: {}, motionHints: [] },
      { ambients: AMBIENTS },
    );
    assert.deepEqual(r, { problems: [], warnings: [] });
  });

  test('bütün problemler tek seferde', () => {
    const { problems } = validateStyle({ name: 'Bad Name', music: { genre: 3, exclude: [1] }, suggestedAmbient: '' });
    assert.equal(problems.length, 4, problems.join('\n'));
  });

  test('music nesne değilse problem; bilinmeyen alanlar uyarı', () => {
    assert.match(validateStyle({ name: 'x', music: [] }).problems[0], /music: nesne olmalı/);
    const { warnings } = validateStyle({ name: 'x', music: { tempo: 'slow' }, extra: 1 });
    assert.deepEqual(warnings.length, 2);
  });

  test('ad dosya adıyla aynı olmalı; olmayan ambient uyarı', () => {
    assert.match(validateStyle({ name: 'a' }, { expectedName: 'b' }).problems[0], /dosya adıyla aynı/);
    assert.match(validateStyle({ name: 'a', suggestedAmbient: 'yok' }, { ambients: AMBIENTS }).warnings[0], /ambient klasöründe yok/);
  });
});

describe('hasMusicProfile / musicStyleText', () => {
  test('boş ya da yok → false / undefined', () => {
    for (const style of [null, { name: 'a' }, { name: 'a', music: {} }, { name: 'a', music: { genre: '  ', exclude: [] } }]) {
      assert.equal(hasMusicProfile(style), false);
      assert.equal(musicStyleText(style), undefined);
    }
  });

  test('profil metni hariç tutulanlar olmadan, alan sırasıyla', () => {
    assert.equal(hasMusicProfile({ music: MUSIC }), true);
    assert.equal(musicStyleText({ music: MUSIC }), 'lofi hip hop, tape saturation, vinyl crackle, Rhodes, rainy night');
    assert.deepEqual(MUSIC_FIELDS, ['genre', 'production', 'instruments', 'aesthetic', 'exclude']);
  });
});

describe('loadStyle', () => {
  let dir;
  before(async () => {
    dir = await tempDir('styles');
    await mkdir(dir.path('s'));
    await writeFile(dir.path('s/iyi.json'), '\uFEFF' + JSON.stringify({ name: 'iyi', music: MUSIC }));
    await writeFile(dir.path('s/bozuk.json'), '{');
    await writeFile(dir.path('s/kotu.json'), JSON.stringify({ name: 'baska' }));
  });
  after(() => dir?.cleanup());

  test('BOM\'lu dosya okunur', async () => {
    assert.deepEqual((await loadStyle('iyi', { dir: dir.path('s') })).style.music, MUSIC);
  });

  test('bilinmeyen stil → mevcutlar; bozuk JSON; geçersiz stil; geçersiz ad', async () => {
    const problem = async (name) => loadStyle(name, { dir: dir.path('s') }).then(() => null, (e) => (assert.ok(e instanceof StyleError), e.problems[0]));
    assert.match(await problem('yok'), /mevcut: bozuk, iyi, kotu/);
    assert.match(await problem('bozuk'), /JSON ayrıştırılamadı/);
    assert.match(await problem('kotu'), /dosya adıyla aynı/);
    assert.match(await problem('../x'), /kebab-case/);
  });
});
