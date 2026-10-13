/**
 * Uçtan uca build: fazla müzik kendiliğinden kırpılır, hiç kullanılmayan parçalar
 * montaj BAŞARIYLA bitince Geri Dönüşüm Kutusu'na taşınır ve project.json'dan çıkar.
 * Gerçek encode; Geri Dönüşüm işlevi sahte (testler kullanıcının çöp kutusunu doldurmasın).
 *
 * 2 dk GET READY + 1/1 × 2 tur = 360 sn. 6 × 100 sn = 600 sn müzik:
 * parça 1-3 tam, parça 4 → 60 sn, parça 5 ve 6 HİÇ kullanılmaz.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { probe } from '../../core/probe.js';
import { makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

const NAMES = ['01-a.m4a', '02-b.m4a', '03-c.m4a', '04-d.m4a', '05-e.m4a', '06-f.m4a'];

describe('build — Pomodoro: fazla müzik otomatik kırpılır, kullanılmayanlar çöp kutusuna', () => {
  let dir;
  let config;
  let report;
  const trashed = [];

  before(async () => {
    dir = await tempDir('build-pomodoro-cleanup');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 320, height: 180 });
    for (const [i, name] of NAMES.entries()) {
      await makeTone(dir.path(`audio/${name}`), { seconds: 100, frequency: 220 + i * 55 });
    }
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      order: NAMES,
      workflow: { audioAdded: NAMES },
      // Onay alanı YOK: fazla müzik soru sorulmadan kırpılır.
      pomodoro: { enabled: true, workMinutes: 1, breakMinutes: 1, rounds: 2, countdownBeep: false },
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      stream: { dir: null },
    }));

    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, {
      render: true,
      trashFile: async (path) => { trashed.push(path); },
    });
  });
  after(() => dir?.cleanup());

  test('soru sorulmadan montaj tamamlandı ve süre timeline kadar (360 sn)', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 360) < 0.2, `süre ${out.duration}`);
    assert.equal(report.pomodoroPlan.comparison.status, 'excess');
    assert.deepEqual(report.pomodoroPlan.trim.tracks.map((t) => Math.round(t.usedDuration)), [100, 100, 100, 60, 0, 0]);
  });

  test('yalnızca hiç kullanılmayan 2 parça Geri Dönüşüm\'e taşındı; kısalan parça yerinde', () => {
    assert.deepEqual(trashed.map((p) => basename(p)), ['05-e.m4a', '06-f.m4a']);
    assert.deepEqual(report.unusedMusic, { moved: ['05-e.m4a', '06-f.m4a'], failed: [] });
  });

  test('project.json sıradan ve eklenme kaydından çıkarıldı (sonraki montaj olmayan dosyayı aramaz)', async () => {
    const json = JSON.parse(await readFile(dir.path('project.json'), 'utf8'));
    assert.deepEqual(json.order, NAMES.slice(0, 4));
    assert.deepEqual(json.workflow.audioAdded, NAMES.slice(0, 4));
  });

  test('tracklist yalnızca kullanılan parçaları damgalar', async () => {
    const text = await readFile(config.output.tracklist, 'utf8');
    assert.equal(text.trim().split('\n').length, 4);
  });
});
