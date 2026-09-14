/**
 * prep/prompts.js — şablon doldurma ve prompts.md üretimi.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import {
  PromptError, TEMPLATE_FILES, buildPromptsMd, codeBlocks, fillTemplate, loadTemplates,
} from '../../prep/prompts.js';
import { listStyles, loadStyle, renderStyleBlock } from '../../prep/styles.js';
import { tempDir } from '../helpers/fixtures.js';

describe('fillTemplate', () => {
  test('her geçiş doldurulur, değer yeniden taranmaz, $& olduğu gibi', () => {
    const out = fillTemplate('{{A}} / {{A}} / {{B}}', { A: '{{B}}', B: 'x $& y' });
    assert.equal(out, '{{B}} / {{B}} / x $& y');
  });

  test('tanınmayan ve bozuk yer tutucular tek hatada', () => {
    assert.throws(
      () => fillTemplate('{{A}} {{NOPE}} {{NOPE}} {{ a }} }}', { A: '1' }, 'faz9.txt'),
      (e) => e instanceof PromptError && e.problems.length === 2 &&
        e.problems[0] === 'faz9.txt: tanınmayan yer tutucu {{NOPE}}' &&
        e.problems[1].startsWith('faz9.txt: bozuk yer tutucu'),
    );
  });

  test('yer tutucusuz metin aynen döner', () => {
    assert.equal(fillTemplate('düz metin { tek }', {}), 'düz metin { tek }');
  });
});

describe('loadTemplates', () => {
  let dir;
  before(async () => {
    dir = await tempDir('prompts');
    await writeFile(dir.path('faz1-master.txt'), '\uFEFFsatır 1\r\nsatır 2\r\n');
    await writeFile(dir.path('faz3-motion.txt'), 'x');
  });
  after(() => dir?.cleanup());

  test('repodaki şablonlar sırayla', async () => {
    const templates = await loadTemplates();
    assert.deepEqual(templates.map((t) => t.file), TEMPLATE_FILES);
    for (const { text } of templates) assert.ok(!text.includes('\r'));
  });

  test('eksik şablon hata, BOM/CRLF temizlenir', async () => {
    await assert.rejects(loadTemplates({ dir: dir.dir }), (e) =>
      e instanceof PromptError && e.problems.length === 1 && e.problems[0].startsWith('faz2-angles.txt: okunamadı'));
    await writeFile(dir.path('faz2-angles.txt'), 'y');
    const [faz1] = await loadTemplates({ dir: dir.dir });
    assert.equal(faz1.text, 'satır 1\nsatır 2\n');
  });
});

describe('buildPromptsMd — repodaki şablonlar × stiller', async () => {
  const templates = await loadTemplates();

  for (const name of await listStyles()) {
    test(name, async () => {
      const { style } = await loadStyle(name);
      const md = buildPromptsMd({ videoName: 'video3-Test & Co', style, templates });
      const { blocks, unclosed } = codeBlocks(md);
      const styleBlock = renderStyleBlock(style);

      assert.ok(md.startsWith('# video3-Test & Co — Üretim promptları\n'));
      assert.ok(md.endsWith('```\n') && !md.endsWith('\n\n'));
      assert.doesNotMatch(md, /\{\{|\}\}|\r/);
      assert.equal(unclosed, false);

      // 1 master + 5 açı + 1 hareket
      assert.equal(blocks.length, 7);
      assert.equal(blocks.filter((b) => b.endsWith(`Style description:\n${styleBlock}`)).length, 6);

      // Kopyalanan metin: yalnızca İngilizce prompt — Türkçe not ve açılı parantez sızmamış
      for (const block of blocks) assert.match(block, /^[\x20-\x7E\n]+$/, block);

      assert.ok(blocks[0].startsWith('Image 1 = composition reference. Image 2 = style reference.\n'));
      for (const b of blocks.slice(1, 6)) assert.ok(b.startsWith('Image 1 = master frame, the only reference.\n'));
      assert.equal(
        blocks[6],
        `Subtle looping motion: ${style.motionHints.join(', ')}.\nEverything else perfectly still. Camera static.`,
      );

      assert.ok(md.includes("**Her varyant MASTER'dan türetilir, varyantın varyantından değil.**"));
      assert.ok(md.includes('Süre **5 saniye**') && md.includes('first frame = last frame'));
      assert.ok(md.includes('Not — doğrulanmadı'));
      assert.ok(md.includes(`\`${name}\` stilinin önerisi`));
    });
  }
});

describe('buildPromptsMd — hatalar', () => {
  const style = {
    name: 's',
    styleBlock: {
      medium: 'm', lines: 'l', light: 'li', texture: 't', contrast: 'c', shading: 's',
      palette: [{ hex: '#000000', role: 'ink' }],
    },
    motionHints: ['steam rising.', ' light pulsing '],
  };

  test('ipuçlarının sonundaki nokta ve boşluk kırpılır', () => {
    const md = buildPromptsMd({ videoName: 'v', style, templates: [{ file: 'f', text: '{{MOTION_HINTS}}.' }] });
    assert.ok(md.endsWith('\n\nsteam rising, light pulsing.\n'));
  });

  test('bütün şablonların problemleri tek hatada', () => {
    const templates = [{ file: 'a.txt', text: '{{X}}' }, { file: 'b.txt', text: '{{Y}}' }];
    assert.throws(() => buildPromptsMd({ videoName: 'v', style, templates }), (e) =>
      e instanceof PromptError && e.problems.length === 2);
  });

  test('kod bloğunda açılı parantez ve kapanmamış blok', () => {
    const templates = [{ file: 'a.txt', text: '```text\npick <angle>\n```\n\n> not dışarıda serbest\n\n```text\naçık' }];
    assert.throws(() => buildPromptsMd({ videoName: 'v', style, templates }), (e) =>
      e instanceof PromptError &&
      e.problems.includes('kapanmamış kod bloğu') &&
      e.problems.some((p) => p.startsWith('kod bloğu 1:')) &&
      e.problems.length === 2);
  });

  test('değerde ``` → hata', () => {
    const bad = { ...style, motionHints: ['```'] };
    assert.throws(() => buildPromptsMd({ videoName: 'v', style: bad, templates: [] }), (e) =>
      e instanceof PromptError && e.problems[0].startsWith('MOTION_HINTS:'));
  });
});
