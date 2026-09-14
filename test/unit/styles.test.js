/**
 * prep/styles.js — stil şeması, doğrulama, stil bloğu metni.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import {
  STYLE_FIELDS, STYLES_DIR, StyleError, listStyles, loadStyle, renderStyleBlock, validateStyle,
} from '../../prep/styles.js';
import { tempDir } from '../helpers/fixtures.js';

/** Diskteki ortak klasörden bağımsız sahte kütüphane. */
const AMBIENTS = ['campfire', 'gentleRain', 'heavyRain', 'rainStorm']
  .map((name) => ({ name, path: `X:\\ambient\\${name}.mp3` }));

/** Geçerli en küçük stil + üzerine yazılanlar. */
const makeStyle = (patch = {}) => ({
  name: 'test-style',
  styleBlock: {
    medium: 'm', lines: 'l', light: 'li', texture: 't', contrast: 'c', shading: 's',
    palette: [{ hex: '#A1b2C3', role: 'accent' }],
    ...(patch.styleBlock ?? {}),
  },
  suggestedAmbient: 'campfire',
  motionHints: ['steam rising'],
  ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== 'styleBlock')),
});

describe('repodaki stiller', () => {
  test('başlangıç seti: 3 stil', async () => {
    assert.deepEqual(await listStyles(), ['anime-cel', 'cozy-realistic', 'watercolor']);
  });

  for (const name of ['anime-cel', 'cozy-realistic', 'watercolor']) {
    test(`${name}: geçerli, uyarısız, önerilen ambient kütüphanede`, async () => {
      const { style, warnings } = await loadStyle(name, { ambients: AMBIENTS });
      assert.equal(style.name, name);
      assert.deepEqual(warnings, []);
      assert.ok(style.styleBlock.palette.length >= 5);
    });
  }

  test('cozy-realistic: video1 bloğunun 7 rengi aynen korunmuş', async () => {
    const { style } = await loadStyle('cozy-realistic');
    assert.deepEqual(
      style.styleBlock.palette.map((c) => c.hex),
      ['#F5E1B8', '#E8A87C', '#4A6B3A', '#7C9A5E', '#D97B6C', '#FAF3E0', '#2E3B2A'],
    );
  });

  // CR denetlenmez: core.autocrlf=true ile checkout CRLF getiriyor, JSON'a zararı yok.
  test('stil dosyaları BOM\'suz', async () => {
    for (const name of await listStyles()) {
      const bytes = await readFile(`${STYLES_DIR}${name}.json`);
      assert.notEqual(bytes[0], 0xef, `${name}: BOM`);
    }
  });
});

describe('validateStyle', () => {
  test('geçerli en küçük stil', () => {
    assert.deepEqual(validateStyle(makeStyle(), { expectedName: 'test-style', ambients: AMBIENTS }), {
      problems: [], warnings: [],
    });
  });

  test('bütün problemler tek seferde', () => {
    const style = makeStyle({
      name: 'other-name',
      styleBlock: { medium: '', shading: undefined, palette: [{ hex: '#12345', role: 'x' }, { hex: '#123456' }] },
      motionHints: [],
    });
    style.styleBlock.lines = 'bold <outline>';
    style.styleBlock.light = 'soft {{light}}';

    const { problems } = validateStyle(style, { expectedName: 'test-style' });
    const expected = [
      'name:', 'styleBlock.medium:', 'styleBlock.shading:', 'styleBlock.palette[0].hex:',
      'styleBlock.palette[1].role:', 'motionHints:', 'styleBlock.lines:', 'styleBlock.light:',
    ];
    for (const prefix of expected) {
      assert.ok(problems.some((p) => p.startsWith(prefix)), `eksik problem: ${prefix}\n${problems.join('\n')}`);
    }
    assert.equal(problems.length, expected.length, problems.join('\n'));
  });

  test('kök nesne değil', () => {
    for (const bad of [null, [], 'x']) {
      assert.equal(validateStyle(bad).problems.length, 1);
    }
  });

  test('kebab-case olmayan name', () => {
    const { problems } = validateStyle(makeStyle({ name: 'Neo_Tokyo' }));
    assert.ok(problems[0].startsWith('name: küçük harf kebab-case'));
  });

  test('bilinmeyen anahtar uyarı, problem değil', () => {
    const style = makeStyle({ extra: 1, styleBlock: { mood: 'calm' } });
    const { problems, warnings } = validateStyle(style);
    assert.deepEqual(problems, []);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes('"styleBlock.mood"')));
  });

  test('kütüphanede olmayan suggestedAmbient uyarı, problem değil', () => {
    const { problems, warnings } = validateStyle(makeStyle({ suggestedAmbient: 'ocean' }), { ambients: AMBIENTS });
    assert.deepEqual(problems, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"ocean".*campfire, gentleRain, heavyRain, rainStorm/);
  });

  test('ambients verilmezse suggestedAmbient aranmaz', () => {
    assert.deepEqual(validateStyle(makeStyle({ suggestedAmbient: 'ocean' })).warnings, []);
  });

  test('yönlü hareket ipucu uyarı verir, döngüsel vermez', () => {
    const style = makeStyle({
      motionHints: ['slow camera pan to the left', 'zooming into the cup', 'steam rising', 'panel lights pulsing'],
    });
    const { problems, warnings } = validateStyle(style);
    assert.deepEqual(problems, []);
    assert.deepEqual(warnings.map((w) => w.slice(0, 14)), ['motionHints[0]', 'motionHints[1]']);
  });
});

describe('loadStyle', () => {
  let dir;
  before(async () => {
    dir = await tempDir('styles');
    await writeFile(dir.path('bom-style.json'), '\uFEFF' + JSON.stringify(makeStyle({ name: 'bom-style' })));
    await writeFile(dir.path('broken.json'), '{ "name": ');
    await writeFile(dir.path('invalid.json'), JSON.stringify(makeStyle({ name: 'invalid', motionHints: 'x' })));
  });
  after(() => dir?.cleanup());

  test('BOM\'lu dosya okunur', async () => {
    const { style } = await loadStyle('bom-style', { dir: dir.dir });
    assert.equal(style.name, 'bom-style');
  });

  test('bilinmeyen stil → mevcutlar listelenir', async () => {
    await assert.rejects(loadStyle('neo-tokyo', { dir: dir.dir }), (e) =>
      e instanceof StyleError && e.problems[0] === 'bilinmeyen stil — mevcut: bom-style, broken, invalid');
  });

  test('bozuk JSON', async () => {
    await assert.rejects(loadStyle('broken', { dir: dir.dir }), (e) =>
      e instanceof StyleError && e.problems[0].startsWith('JSON ayrıştırılamadı'));
  });

  test('geçersiz stil → StyleError, problem listesiyle', async () => {
    await assert.rejects(loadStyle('invalid', { dir: dir.dir }), (e) =>
      e instanceof StyleError && e.problems.length === 1 && e.problems[0].startsWith('motionHints:'));
  });

  for (const bad of ['../styles/anime-cel', 'Anime-Cel', '', 'a b']) {
    test(`geçersiz ad ${JSON.stringify(bad)} → dosya aranmaz`, async () => {
      await assert.rejects(loadStyle(bad, { dir: dir.dir }), (e) =>
        e instanceof StyleError && e.problems[0].startsWith('stil adı küçük harf kebab-case'));
    });
  }
});

describe('renderStyleBlock', () => {
  test('alan sırası, başlıklar, palet satırları', () => {
    const text = renderStyleBlock(makeStyle({
      styleBlock: { palette: [{ hex: '#a1b2c3', role: 'accent' }, { hex: '#000000', role: 'ink' }] },
    }));
    assert.equal(text, [
      'Medium / technique: m',
      'Line quality: l',
      'Color palette:',
      '- #A1B2C3 accent',
      '- #000000 ink',
      'Lighting: li',
      'Texture / grain: t',
      'Contrast: c',
      'Shading: s',
    ].join('\n'));
  });

  test('her alan çıktıda, repodaki stillerde markdown ve açılı parantez yok', async () => {
    for (const name of await listStyles()) {
      const text = renderStyleBlock((await loadStyle(name)).style);
      for (const { label } of STYLE_FIELDS) assert.ok(text.includes(`${label}:`), `${name}: ${label}`);
      assert.doesNotMatch(text, /[<>*]|\{\{/);
    }
  });
});
