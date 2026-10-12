/**
 * prep/project-status.js — nextStep karar tablosu (dosya yok, durum elle kurulur).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SKIPPABLE_STEPS, canonicalWorkflow, nextStep } from '../../prep/project-status.js';

/** Taze proje durumu + üzerine yazılanlar. */
const makeStatus = (patch = {}) => ({
  dir: 'X:\\videolar\\v',
  projectPath: 'X:\\videolar\\v\\project.json',
  promptsPath: 'X:\\videolar\\v\\prompts.md',
  projectJson: { ok: true, data: {}, error: null },
  master: null,
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

  test('klip hazır + müzik yok → Müzik (elle, atlanamaz)', () => {
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
      clip: readyClip,
      audioCount: 1,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'audio');
  });

  test('multi-track müzik: tüm parçalar (2/2) tamamlandığında montaj adımına (build) geçilir', () => {
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
      clip: readyClip,
      audioCount: 2,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'build');
  });

  test('multi-track müzik: status === completed_by_user olduğunda eksik parçalara (15/17) bakılmaksızın sonraki adıma (build) geçilir', () => {
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
      clip: readyClip,
      audioCount: 15,
      projectJson: { ok: true, data: { music: musicPlan }, error: null },
    });
    assert.equal(nextStep(status).id, 'build');
  });

  test('video klip müzikten önce gelir', () => {
    assert.equal(id({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', audioCount: 0 }), 'faz3');
  });

  test('clip yazılı ama dosyası yok → klip seçimi, not ile', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.png', clip: missingClip, clips: ['yeni.mp4'], audioCount: 3 }));
    assert.equal(step.id, 'clip');
    assert.ok(step.detail.startsWith("clip'teki dosya bulunamadı: X:\\videolar\\v\\videolar\\eski.mp4\n"));
  });

  test('MASTER var, klip yok → Video (faz3)', () => {
    const step = nextStep(makeStatus({ master: 'X:\\videolar\\v\\resimler\\MASTER.PNG' }));
    assert.deepEqual([step.id, step.kind, step.skippable], ['faz3', 'manual', true]);
    assert.ok(step.detail.includes('döngü klibini videolar\\ altına'));
  });

  // Master görseli adımı kaldırıldı: taze proje doğrudan klibe bakıyor.
  test('taze proje → klip', () => {
    const fresh = nextStep(makeStatus());
    assert.deepEqual([fresh.id, fresh.kind, fresh.skippable], ['faz3', 'manual', true]);
  });
});

describe('nextStep — tek resim modu (video.source = image)', () => {
  const master = 'X:\\videolar\\v\\resimler\\MASTER.png';
  const still = { videoSource: 'image' };
  const readyImage = { value: './resimler/MASTER.png', path: master, exists: true };

  test('görsel seçilmemiş + aday var → görsel seçimi (otomatik), Faz 3 sorulmaz', () => {
    const step = nextStep(makeStatus({ ...still, master, clips: [master] }));
    assert.deepEqual([step.id, step.kind, step.title], ['clip', 'auto', 'Görseli seç']);
  });

  test('aday yok → görsel bekleniyor (faz3 değil)', () => {
    const step = nextStep(makeStatus(still), { skipped: new Set(['faz3']) });
    assert.deepEqual([step.id, step.kind], ['clip', 'manual']);
    assert.match(step.detail, /resimler/);
    assert.equal(id(still), 'clip');
  });

  test('görsel hazır → müzik, sonra montaj', () => {
    assert.equal(id({ ...still, master, clip: readyImage }), 'audio');
    assert.equal(id({ ...still, master, clip: readyImage, audioCount: 3 }), 'build');
  });
});

describe('nextStep — bu oturumda atlananlar', () => {
  test('faz3 atlanınca "klip bekleniyor" (atlanamaz)', () => {
    assert.equal(id({}), 'faz3');
    const step = nextStep(makeStatus({}), { skipped: new Set(['faz3']) });
    assert.deepEqual([step.id, step.kind, step.skippable], ['clip', 'manual', false]);
  });

  test('kanıt gerektiren adımlar atlanmaz: audio atlandı sayılsa da yine audio', () => {
    assert.equal(id({ clip: readyClip }, { skipped: new Set(['audio', 'faz3']) }), 'audio');
  });

  test('yalnızca faz3 atlanabilir', () => {
    assert.deepEqual(SKIPPABLE_STEPS, ['faz3']);
  });
});

describe('canonicalWorkflow — 6 adımlı akış', () => {
  const master = 'X:\\videolar\\v\\resimler\\MASTER.png';
  const flow = (patch) => canonicalWorkflow(makeStatus({
    style: null, angles: [], ...patch,
  }));
  const withData = (data) => ({ projectJson: { ok: true, data, error: null } });

  test('ilk tamamlanmamış adım current; sonrakiler pending', () => {
    const wf = flow({});
    assert.equal(wf.current, 'video');
    assert.equal(wf.currentTitle, 'Video');
    assert.deepEqual(wf.steps.map((s) => s.id), ['project', 'video', 'music', 'order', 'build', 'publish']);
    assert.deepEqual(wf.steps.map((s) => s.status), [
      'done', 'current', 'pending', 'pending', 'pending', 'pending',
    ]);
    assert.deepEqual(wf.steps.map((s) => s.number), [1, 2, 3, 4, 5, 6]);
  });

  test('bozuk project.json → proje adımı', () => {
    assert.equal(flow({ projectJson: { ok: false, data: null, error: 'x' } }).current, 'project');
  });

  test('video adımı klip + kırpma kaydı ister; müzik sonra sıralama', () => {
    const video = { cropBottom: 150 };
    assert.equal(flow({ master, clip: readyClip }).current, 'video');
    assert.equal(flow({ master, clip: readyClip, ...withData({ video }) }).current, 'music');
    assert.equal(flow({ master, clip: readyClip, audioCount: 2, ...withData({ video }) }).current, 'order');
    assert.equal(flow({ master, clip: readyClip, audioCount: 2, ...withData({ video, order: ['a'] }) }).current, 'build');
  });

  test('tek resim: video adımı seçili görsel + kırpma kaydıyla tamam', () => {
    const image = { value: './resimler/MASTER.png', path: master, exists: true };
    const data = withData({ video: { source: 'image', cropBottom: 0 } });
    const wf = flow({ master, videoSource: 'image', ...data });
    assert.equal(wf.current, 'video');
    assert.equal(flow({ master, videoSource: 'image', clip: image, ...data }).current, 'music');
  });

  test('çıktı varsa yayın; tüm adımlar tamam', () => {
    const wf = flow({ output: { path: 'o', exists: true } });
    assert.equal(wf.current, 'publish');
    assert.ok(wf.steps.slice(0, 5).every((s) => s.status === 'done'));
  });
});
