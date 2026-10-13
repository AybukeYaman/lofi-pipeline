/**
 * Uçtan uca build: müzik Pomodoro timeline'ından KISA. Montaj durmaz; ses sessizlikle
 * timeline süresine tamamlanır, video tam süre (300 sn) sürer, kalan kısmı Ambiance
 * (seçiliyse) doldurur. Gerçek encode.
 *
 * 2 dk GET READY + 1/1 × 2 tur − son BREAK (video molayla bitmez) = 300 sn; müzik 2 × 100 = 200 sn (100 sn eksik).
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { probe } from '../../core/probe.js';
import { channelStats, countFrames, makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

/** Bölüm sessiz mi? (-inf ya da ölçülemeyen değer sessizlik sayılır.) */
const isSilent = (stats) => stats.every(({ rmsDb }) => !(rmsDb > -70));

describe('build — Pomodoro: müzik kısa, montaj durmaz', () => {
  let dir;

  const project = (extra = {}) => ({
    clip: './clip.mp4',
    audioDir: './audio',
    pomodoro: { enabled: true, workMinutes: 1, breakMinutes: 1, rounds: 2, countdownBeep: false },
    video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
    stream: { dir: null },
    ...extra,
  });

  before(async () => {
    dir = await tempDir('build-pomodoro-short');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 320, height: 180 });
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 100, frequency: 330 });
    await makeTone(dir.path('audio/02-b.m4a'), { seconds: 100, frequency: 440 });
    await makeTone(dir.path('ambient.m4a'), { seconds: 20, frequency: 110 });
  });
  after(() => dir?.cleanup());

  describe('Ambiance yok', () => {
    let config;
    let report;

    before(async () => {
      await writeFile(dir.path('plain.json'), JSON.stringify(project({ output: { dir: './out-plain' } })));
      config = await loadProject(dir.path('plain.json'));
      report = await runBuild(config, { render: true });
    });

    test('doğrulama engel çıkarmadı; eksik müzik uyarı olarak raporlandı', () => {
      assert.equal(report.pomodoroPlan.comparison.status, 'short');
      assert.ok(report.warnings.some((w) => /kısa/.test(w.message) && /Ambiance/.test(w.message)));
    });

    test('video tam timeline süresinde (300 sn), müziğin süresinde (200 sn) değil', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 300) < 0.3, `süre ${out.duration}`);
      assert.ok(Math.abs(await countFrames(config.output.video) - 300 * 24) <= 2);
    });

    test('müzik çalıyor, bittikten sonraki kısım sessiz', async () => {
      assert.equal(isSilent(await channelStats(config.output.video, { start: 20, duration: 60 })), false);
      assert.equal(isSilent(await channelStats(config.output.video, { start: 220, duration: 60 })), true);
    });

    test('tracklist yalnızca gerçek parçaları damgalar', async () => {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(config.output.tracklist, 'utf8');
      assert.equal(text.trim().split('\n').length, 2);
    });
  });

  describe('Ambiance var', () => {
    let config;

    before(async () => {
      await writeFile(dir.path('amb.json'), JSON.stringify(project({
        ambient: './ambient.m4a',
        output: { dir: './out-amb' },
      })));
      config = await loadProject(dir.path('amb.json'));
      await runBuild(config, { render: true });
    });

    test('müzik bittikten sonra kalan süreyi Ambiance doldurur (sessiz değil)', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 300) < 0.3, `süre ${out.duration}`);
      assert.equal(isSilent(await channelStats(config.output.video, { start: 220, duration: 60 })), false);
    });
  });
});
