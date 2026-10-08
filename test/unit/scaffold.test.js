/**
 * prep/scaffold.js — isim kuralları ve proje planı (diske dokunmaz).
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { PROJECT_SUBDIRS, planProject, validateVideoName } from '../../prep/scaffold.js';

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

describe('planProject', () => {
  const base = { videosDir: 'X:\\videolar', videoName: 'video3-Test' };
  const ambient = { name: 'heavyRain', path: 'X:\\ortak\\heavyRain.mp3' };

  test('klasörler ve dosyalar', () => {
    const plan = planProject({ ...base, ambient });
    const dir = join('X:\\videolar', 'video3-Test');
    assert.equal(plan.dir, dir);
    assert.deepEqual(PROJECT_SUBDIRS, ['audio', 'resimler', 'videolar']);
    assert.deepEqual(plan.subdirs, PROJECT_SUBDIRS.map((d) => join(dir, d)));
    // Kamera açısı promptları kaldırıldı: proje yalnızca project.json ile kurulur.
    assert.deepEqual(plan.files.map((f) => [f.name, f.bom]), [['project.json', false]]);
    for (const f of plan.files) {
      assert.equal(f.path, join(dir, f.name));
      assert.ok(f.content.endsWith('\n') && !f.content.endsWith('\n\n'), f.name);
    }
  });

  test('project.json: seçilen Ambiance plana gider', () => {
    const json = JSON.parse(planProject({ ...base, ambient }).files[0].content);
    assert.equal(json.clip, '');
    assert.equal(json.ambient, 'X:\\ortak\\heavyRain.mp3');
    assert.deepEqual(json.video, { cropBottom: 150, aspect: '16:9' });
    assert.ok(!Object.hasOwn(json, 'style'), 'stil kavramı kaldırıldı');
  });

  test('müzik planı yazılmaz; ambient yoksa anahtar yok', () => {
    const json = JSON.parse(planProject({ ...base, ambient: null }).files[0].content);
    assert.deepEqual(Object.keys(json), ['clip', 'audioDir', 'video', 'output']);
  });

  test('müzik planı yalnızca açıkça verilince yazılır', () => {
    const musicPlan = { style: 'Lo-fi / mellow / instrumental', totalTracks: 3, tracks: [] };
    const json = JSON.parse(planProject({ ...base, ambient: null, musicPlan }).files[0].content);
    assert.deepEqual(json.music, musicPlan);
  });

});
