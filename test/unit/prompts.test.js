/**
 * prep/prompts.js — kamera açısı şablonu ve prompts.md üretimi.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import {
  PromptError, TEMPLATE_FILES, buildPromptsMd, codeBlocks, getAnglePrompts, loadTemplates,
} from '../../prep/prompts.js';
import { tempDir } from '../helpers/fixtures.js';

describe('loadTemplates', () => {
  let dir;
  before(async () => { dir = await tempDir('prompts'); });
  after(() => dir?.cleanup());

  test('repodaki şablon: yalnızca kamera açıları, yer tutucusuz', async () => {
    const templates = await loadTemplates();
    assert.deepEqual(templates.map((t) => t.file), TEMPLATE_FILES);
    assert.deepEqual(TEMPLATE_FILES, ['faz2-angles.txt']);
    for (const { text } of templates) assert.doesNotMatch(text, /\r|\{\{|\}\}/);
  });

  test('eksik şablon hata, BOM/CRLF temizlenir', async () => {
    await assert.rejects(loadTemplates({ dir: dir.dir }), (e) =>
      e instanceof PromptError && e.problems[0].startsWith('faz2-angles.txt: okunamadı'));
    await writeFile(dir.path('faz2-angles.txt'), '﻿satır 1\r\nsatır 2\r\n');
    const [angles] = await loadTemplates({ dir: dir.dir });
    assert.equal(angles.text, 'satır 1\nsatır 2\n');
  });
});

describe('buildPromptsMd — repodaki şablon', async () => {
  const templates = await loadTemplates();

  test('5 açı bloğu, yalnızca İngilizce ve stil tarifi yok', () => {
    const md = buildPromptsMd({ videoName: 'video3-Test & Co', templates });
    const { blocks, unclosed } = codeBlocks(md);
    assert.ok(md.startsWith('# video3-Test & Co — Kamera açısı promptları\n'));
    assert.ok(md.endsWith('```\n') && !md.endsWith('\n\n'));
    assert.equal(unclosed, false);
    assert.equal(blocks.length, 5);
    for (const block of blocks) {
      assert.ok(block.startsWith('Image 1 = master frame, the only reference.\n'), block);
      assert.match(block, /^[\x20-\x7E\n]+$/, block);
      assert.doesNotMatch(block, /Style description/);
    }
    assert.ok(md.includes("**Her varyant MASTER'dan türetilir, varyantın varyantından değil.**"));
  });

  test('getAnglePrompts aynı şablon metnini verir', async () => {
    assert.equal(await getAnglePrompts({ templates }), templates[0].text.trimEnd());
    assert.equal(await getAnglePrompts({ templates: [] }), '');
  });
});

describe('buildPromptsMd — hatalar', () => {
  test('kod bloğunda açılı parantez ve kapanmamış blok tek hatada', () => {
    const templates = [{ file: 'a.txt', text: '```text\npick <angle>\n```\n\n> not dışarıda serbest\n\n```text\naçık' }];
    assert.throws(() => buildPromptsMd({ videoName: 'v', templates }), (e) =>
      e instanceof PromptError &&
      e.problems.includes('kapanmamış kod bloğu') &&
      e.problems.some((p) => p.startsWith('kod bloğu 1:')) &&
      e.problems.length === 2);
  });
});
