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
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', clip: readyClip, audioCount: 15 }));
    assert.deepEqual([step.id, step.kind], ['build', 'auto']);
    assert.ok(step.detail.includes('./videolar/in.mp4 · 15 parça'));
  });

  test('klip hazır + müzik yok → Suno (elle, atlanamaz)', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', clip: readyClip }));
    assert.deepEqual([step.id, step.kind, step.skippable], ['audio', 'manual', false]);
    assert.ok(step.detail.includes('X:\\videolar\\v\\audio'));
  });

  test('clip boş + videolar\'da klip var → klip seçimi (otomatik)', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', clips: ['a.mp4', 'b.mp4'], audioCount: 3 }));
    assert.deepEqual([step.id, step.kind], ['clip', 'auto']);
    assert.ok(step.detail.includes('2 klip var'));
  });

  test('multi-track müzik: tamamlanmamış parçalar varken (1/17) audio adımında kalınır', () => {
    const musicPlan = {
      totalTracks: 17,
      completedCount: 1,
      tracks: [
        { number: 1, status: 'completed' },
        { number: 2, status: 'pending' },
      ],
    };
    const status = makeStatus({
      master: 'X:\\videolar\\v\\resimler\\MASTER.png',
      audioCount: 1,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'audio');
  });

  test('multi-track müzik: tüm parçalar (17/17) tamamlandığında klip adımına (faz3/clip) geçilir', () => {
    const musicPlan = {
      totalTracks: 2,
      completedCount: 2,
      status: 'completed',
      tracks: [
        { number: 1, status: 'completed' },
        { number: 2, status: 'completed' },
      ],
    };
    const status = makeStatus({
      master: 'X:\\videolar\\v\\resimler\\MASTER.png',
      audioCount: 2,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'faz3');
  });

  test('multi-track müzik: status === completed_by_user olduğunda eksik parçalara (15/17) bakılmaksızın sonraki adıma geçilir', () => {
    const musicPlan = {
      totalTracks: 17,
      completedCount: 15,
      status: 'completed_by_user',
      tracks: [
        { number: 1, status: 'completed' },
        { number: 16, status: 'pending' },
        { number: 17, status: 'pending' },
      ],
    };
    const status = makeStatus({
      master: 'X:\\videolar\\v\\resimler\\MASTER.png',
      audioCount: 15,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'faz3');
  });

  test('müzik klipten önce gelir', () => {
    assert.equal(id({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', audioCount: 0 }), 'audio');
  });

  test('clip yazılı ama dosyası yok → klip seçimi, not ile', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', clip: missingClip, clips: ['yeni.mp4'], audioCount: 3 }));
    assert.equal(step.id, 'clip');
    assert.ok(step.detail.startsWith("clip'teki dosya bulunamadı: X:\\videolar\\v\\videolar\\eski.mp4\n"));
  });

  test('MASTER var, müzik yok → Music (audio)', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.PNG' }));
    assert.deepEqual([step.id, step.kind, step.skippable], ['audio', 'manual', false]);
    assert.ok(step.detail.includes('X:\\videolar\\v\\audio'));
  });

  test('taze proje → Faz 1; promptlar yolu notu', () => {
    const fresh = nextStep(makeStatus());
    assert.deepEqual([fresh.id, fresh.kind, fresh.skippable], ['faz1', 'manual', true]);
    assert.ok(fresh.detail.includes('prompts.md → Faz 1 ile master frame\'i üret'));
  });
});

describe('nextStep — bu oturumda atlananlar', () => {
  test('faz1 atlanınca audio, audio ve faz3 atlanınca "klip bekleniyor" (atlanamaz)', () => {
    assert.equal(id({}, { skipped: new Set(['faz1']) }), 'audio');
    const step = nextStep(makeStatus({ audioCount: 1 }), { skipped: new Set(['faz1', 'faz3']) });
    assert.deepEqual([step.id, step.kind, step.skippable], ['clip', 'manual', false]);
  });

  test('kanıt gerektiren adımlar atlanmaz: audio atlandı sayılsa da yine audio', () => {
    assert.equal(id({ clip: readyClip }, { skipped: new Set(['audio', 'faz1', 'faz3']) }), 'audio');
  });

  test('yalnızca faz1 ve faz3 atlanabilir', () => {
    assert.deepEqual(SKIPPABLE_STEPS, ['faz1', 'faz3']);
  });
});
