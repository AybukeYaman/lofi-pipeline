/**
 * prep/project-status.js — nextStep karar tablosu (dosya yok, durum elle kurulur).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SKIPPABLE_STEPS, nextStep } from '../../prep/project-status.js';

/** Taze proje durumu + üzerine yazılanlar. */
const makeStatus = (patch = {}) => ({
  dir: 'X:\\videolar\\v',
  projectPath: 'X:\\videolar\\v\\project.json',
  promptsPath: 'X:\\videolar\\v\\prompts.md',
  projectJson: { ok: true, data: {}, error: null },
  master: null,
  styleRef: null,
  clips: [],
  clip: { value: '', path: null, exists: false },
  audioDir: 'X:\\videolar\\v\\audio',
  audioCount: 0,
  output: { path: 'X:\\videolar\\v\\out\\final_ambient.mp4', exists: false },
  ...patch,
});

const readyClip = { value: './videolar/in.mp4', path: 'X:\\videolar\\v\\videolar\\in.mp4', exists: true };
const missingClip = { value: './videolar/eski.mp4', path: 'X:\\videolar\\v\\videolar\\eski.mp4', exists: false };
const id = (patch, options) => nextStep(makeStatus(patch), options).id;

describe('nextStep — karar tablosu (sondan başa)', () => {
  test('bozuk project.json her şeyden önce', () => {
    const step = nextStep(makeStatus({
      projectJson: { ok: false, data: null, error: 'JSON ayrıştırılamadı: x' },
      output: { path: 'o', exists: true },
    }));
    assert.equal(step.id, 'fix-project');
    assert.equal(step.kind, 'manual');
    assert.ok(step.detail.endsWith('JSON ayrıştırılamadı: x'));
  });

  test('çıktı varsa bitti — diğer kanıtlara bakılmaz', () => {
    const step = nextStep(makeStatus({ output: { path: 'O:\\final.mp4', exists: true } }));
    assert.deepEqual([step.id, step.kind, step.detail], ['done', 'done', 'Çıktı: O:\\final.mp4']);
  });

  test('klip hazır + müzik var → montaj (otomatik)', () => {
    const step = nextStep(makeStatus({ clip: readyClip, audioCount: 15 }));
    assert.deepEqual([step.id, step.kind], ['build', 'auto']);
    assert.ok(step.detail.includes('./videolar/in.mp4 · 15 parça'));
  });

  test('klip hazır + müzik yok → Suno (elle, atlanamaz)', () => {
    const step = nextStep(makeStatus({ clip: readyClip }));
    assert.deepEqual([step.id, step.kind, step.skippable], ['audio', 'manual', false]);
    assert.ok(step.detail.includes('X:\\videolar\\v\\audio'));
  });

  test('clip boş + videolar\'da klip var → klip seçimi (otomatik)', () => {
    const step = nextStep(makeStatus({ clips: ['a.mp4', 'b.mp4'], master: null }));
    assert.deepEqual([step.id, step.kind], ['clip', 'auto']);
    assert.ok(step.detail.includes('2 klip var'));
  });

  test('müzik klipten önce gelse de klip seçimi istenir', () => {
    assert.equal(id({ clips: ['a.mp4'], audioCount: 3 }), 'clip');
  });

  test('clip yazılı ama dosyası yok → klip seçimi, not ile', () => {
    const step = nextStep(makeStatus({ clip: missingClip, clips: ['yeni.mp4'], audioCount: 3 }));
    assert.equal(step.id, 'clip');
    assert.ok(step.detail.startsWith("clip'teki dosya bulunamadı: X:\\videolar\\v\\videolar\\eski.mp4\n"));
  });

  test('MASTER var, klip yok → Faz 3', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.PNG' }));
    assert.deepEqual([step.id, step.kind, step.skippable], ['faz3', 'manual', true]);
    assert.ok(step.detail.includes('X:\\videolar\\v\\prompts.md'));
  });

  test('taze proje → Faz 1; referans görseli var/yok notu', () => {
    const fresh = nextStep(makeStatus());
    assert.deepEqual([fresh.id, fresh.kind, fresh.skippable], ['faz1', 'manual', true]);
    assert.ok(fresh.detail.includes("Image 2'yi elle ekle"));

    const withRef = nextStep(makeStatus({ styleRef: 'X:\\videolar\\v\\resimler\\style-ref.jpg' }));
    assert.ok(withRef.detail.includes('Image 2 (stil referansı): X:\\videolar\\v\\resimler\\style-ref.jpg'));
  });
});

describe('nextStep — bu oturumda atlananlar', () => {
  test('faz1 atlanınca faz3, ikisi atlanınca "klip bekleniyor" (atlanamaz)', () => {
    assert.equal(id({}, { skipped: new Set(['faz1']) }), 'faz3');
    const step = nextStep(makeStatus(), { skipped: new Set(['faz1', 'faz3']) });
    assert.deepEqual([step.id, step.kind, step.skippable], ['clip', 'manual', false]);
  });

  test('kanıt gerektiren adımlar atlanmaz: audio atlandı sayılsa da yine audio', () => {
    assert.equal(id({ clip: readyClip }, { skipped: new Set(['audio', 'faz1', 'faz3']) }), 'audio');
  });

  test('yalnızca faz1 ve faz3 atlanabilir', () => {
    assert.deepEqual(SKIPPABLE_STEPS, ['faz1', 'faz3']);
  });
});
