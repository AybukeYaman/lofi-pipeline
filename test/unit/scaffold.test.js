/**
 * prep/scaffold.js — isim kuralları ve proje planı (diske dokunmaz).
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { loadTemplates } from '../../prep/prompts.js';
import { PROJECT_SUBDIRS, planProject, validateVideoName } from '../../prep/scaffold.js';
import { loadStyle } from '../../prep/styles.js';

describe('validateVideoName', () => {
  for (const ok of ['video3-Neo Tokyo Night', 'video1- A Quiet Afternoon with a Book & Coffee', 'Kış (2026)', 'console']) {
    test(`geçerli: ${JSON.stringify(ok)}`, () => assert.deepEqual(validateVideoName(ok), []));
  }

  for (const [bad, fragment] of [
    ['', 'boş'],
    ['   ', 'boş'],
    ['video:3', 'geçersiz karakter'],
    ['neden?', 'geçersiz karakter'],
    ['a/b', 'geçersiz karakter'],
    ['video3.', 'nokta ya da boşluk'],
    ['video3 ', 'nokta ya da boşluk'],
    [' video3', 'boşlukla başlayamaz'],
    ['CON', 'ayrılmış'],
    ['nul.txt', 'ayrılmış'],
  ]) {
    test(`geçersiz: ${JSON.stringify(bad)}`, () => {
      const problems = validateVideoName(bad);
      assert.equal(problems.length, 1, problems.join('\n'));
      assert.ok(problems[0].includes(fragment), problems[0]);
    });
  }

  test('birden fazla problem tek seferde, karakterler tekilleştirilir', () => {
    const problems = validateVideoName('a:b:c?.');
    assert.equal(problems.length, 2);
    assert.equal(problems[0], 'isim Windows\'ta geçersiz karakter içeriyor: ":" "?"');
  });
});

describe('planProject', async () => {
  const templates = await loadTemplates();
  const { style } = await loadStyle('cozy-realistic');
  const base = { videosDir: 'X:\\videolar', videoName: 'video3-Test', style, templates };
  const ambient = { name: 'heavyRain', path: 'X:\\ortak\\heavyRain.mp3' };

  test('klasörler ve dosyalar', () => {
    const plan = planProject({ ...base, ambient, styleRef: null });
    const dir = join('X:\\videolar', 'video3-Test');
    assert.equal(plan.dir, dir);
    assert.deepEqual(plan.subdirs, PROJECT_SUBDIRS.map((d) => join(dir, d)));
    assert.deepEqual(plan.files.map((f) => [f.name, f.bom]), [
      ['STYLE_BLOCK.txt', true], ['project.json', false], ['prompts.md', true],
    ]);
    assert.deepEqual(plan.copies, []);
    for (const f of plan.files) {
      assert.equal(f.path, join(dir, f.name));
      assert.ok(f.content.endsWith('\n') && !f.content.endsWith('\n\n'), f.name);
    }
  });

  test('project.json ambient ile', () => {
    const plan = planProject({ ...base, ambient, styleRef: null });
    assert.equal(plan.files[1].content, JSON.stringify({
      clip: '',
      audioDir: './audio',
      ambient: 'X:\\ortak\\heavyRain.mp3',
      video: { cropBottom: 150, aspect: '16:9' },
      output: { dir: './out' },
    }, null, 2) + '\n');
  });

  test('project.json ambient yoksa anahtar hiç yok', () => {
    const json = JSON.parse(planProject({ ...base, ambient: null, styleRef: null }).files[1].content);
    assert.ok(!Object.hasOwn(json, 'ambient'));
    assert.deepEqual(Object.keys(json), ['clip', 'audioDir', 'video', 'output']);
  });

  test('referans görseli resimler/style-ref olarak kopyalanır, uzantı küçük harf', () => {
    const plan = planProject({ ...base, ambient: null, styleRef: 'Y:\\styles\\refs\\cozy-realistic.JPG' });
    assert.deepEqual(plan.copies, [{
      from: 'Y:\\styles\\refs\\cozy-realistic.JPG',
      path: join('X:\\videolar', 'video3-Test', 'resimler', 'style-ref.jpg'),
    }]);
  });

  test('STYLE_BLOCK.txt ve prompts.md stili taşır', () => {
    const [block, , prompts] = planProject({ ...base, ambient: null, styleRef: null }).files;
    assert.ok(block.content.startsWith('Medium / technique: Digital photograph'));
    assert.ok(prompts.content.startsWith('# video3-Test — Üretim promptları\n'));
    assert.ok(prompts.content.includes(block.content.trimEnd()));
  });
});
