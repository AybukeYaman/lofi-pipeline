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
  const { style } = await loadStyle('anime-cel');
  const base = { videosDir: 'X:\\videolar', videoName: 'video3-Test', templates };
  const ambient = { name: 'heavyRain', path: 'X:\\ortak\\heavyRain.mp3' };

  test('klasörler ve dosyalar: stil görseli ve referans yok', () => {
    const plan = planProject({ ...base, style, ambient });
    const dir = join('X:\\videolar', 'video3-Test');
    assert.equal(plan.dir, dir);
    assert.deepEqual(PROJECT_SUBDIRS, ['audio', 'resimler', 'videolar']);
    assert.deepEqual(plan.subdirs, PROJECT_SUBDIRS.map((d) => join(dir, d)));
    assert.deepEqual(plan.files.map((f) => [f.name, f.bom]), [['project.json', false], ['prompts.md', true]]);
    for (const f of plan.files) {
      assert.equal(f.path, join(dir, f.name));
      assert.ok(f.content.endsWith('\n') && !f.content.endsWith('\n\n'), f.name);
    }
  });

  test('project.json: müzik stili adı ve profili plana gider', () => {
    const json = JSON.parse(planProject({ ...base, style, ambient }).files[0].content);
    assert.equal(json.clip, '');
    assert.equal(json.ambient, 'X:\\ortak\\heavyRain.mp3');
    assert.deepEqual(json.video, { cropBottom: 150, aspect: '16:9' });
    assert.equal(json.style, 'anime-cel');
    assert.ok(json.music.style.includes('lofi'), json.music.style);
  });

  test('stil yoksa style anahtarı yok, planlayıcı varsayılanı; ambient yoksa anahtar yok', () => {
    const json = JSON.parse(planProject({ ...base, ambient: null }).files[0].content);
    assert.deepEqual(Object.keys(json), ['clip', 'audioDir', 'video', 'output', 'music']);
    assert.equal(json.music.style, 'Lo-fi / mellow / instrumental');
  });

  test('prompts.md yalnızca kamera açısı promptlarını taşır', () => {
    const prompts = planProject({ ...base, ambient: null }).files[1].content;
    assert.ok(prompts.startsWith('# video3-Test — Kamera açısı promptları\n'));
    assert.ok(prompts.includes('Extreme low angle'));
    assert.ok(!prompts.includes('Style description'));
  });
});
