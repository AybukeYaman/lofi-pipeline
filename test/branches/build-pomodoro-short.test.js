/**
 * Uçtan uca build: müzik Pomodoro timeline'ından KISA. Montaj durmaz; liste bitince
 * baştaki parçalar TEKRAR çalar, video tam süre (300 sn) sürer. Hangi parçanın çaldığı
 * videodan ses tonu (frekans) okunarak doğrulanır. Gerçek encode.
 *
 * 2 dk GET READY + 1/1 × 2 tur − son BREAK (video molayla bitmez) = 300 sn; müzik 2 × 100 = 200 sn
 * (100 sn eksik): 01-a (330 Hz) 0-100, 02-b (440 Hz) 100-200, 01-a tekrar 200-300.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { probe } from '../../core/probe.js';
import { channelStats, countFrames, makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

/** Bölüm sessiz mi? (-inf ya da ölçülemeyen değer sessizlik sayılır.) */
const isSilent = (stats) => stats.every(({ rmsDb }) => !(rmsDb > -70));

/** Videonun `at` saniyesinden 1 sn'lik sesin baskın frekansı (sıfır geçişlerinden, Hz). */
function frequencyAt(video, at) {
  const run = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', String(at), '-i', video, '-t', '1', '-vn',
    '-ac', '1', '-ar', '48000', '-f', 's16le', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 24 });
  assert.equal(run.status, 0, run.stderr.toString());
  let crossings = 0;
  let previous = 0;
  for (let i = 0; i + 1 < run.stdout.length; i += 2) {
    const sample = run.stdout.readInt16LE(i);
    if (sample !== 0) {
      if (previous !== 0 && Math.sign(sample) !== Math.sign(previous)) crossings += 1;
      previous = sample;
    }
  }
  return crossings / 2;
}

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

    test('doğrulama engel çıkarmadı; eksik müzik ve tekrar eden parçalar uyarı olarak raporlandı', () => {
      assert.equal(report.pomodoroPlan.comparison.status, 'short');
      assert.ok(report.warnings.some((w) => /01:40 kısa/.test(w.message) && /tekrar çalacak: 01-a/.test(w.message)));
    });

    test('video tam timeline süresinde (300 sn), müziğin süresinde (200 sn) değil', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 300) < 0.3, `süre ${out.duration}`);
      assert.ok(Math.abs(await countFrames(config.output.video) - 300 * 24) <= 2);
    });

    test('liste bitince sessizlik yok: ilk parça baştan tekrar çalar (frekans videodan okunur)', async () => {
      assert.equal(isSilent(await channelStats(config.output.video, { start: 220, duration: 60 })), false);
      const expect = [[50, 330, '01-a'], [150, 440, '02-b'], [250, 330, '01-a tekrar']];
      for (const [at, hz, name] of expect) {
        const measured = frequencyAt(config.output.video, at);
        assert.ok(Math.abs(measured - hz) < 10, `${name} (${at} sn): ${measured} Hz, beklenen ${hz} Hz`);
      }
    });

    test('tracklist tekrar çalan parçayı kendi damgasıyla ve (tekrar) ekiyle yazar', async () => {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(config.output.tracklist, 'utf8');
      const lines = text.trim().split('\n');
      assert.equal(lines.length, 3);
      assert.match(lines[2], /^3:20 .*\(tekrar\)$/);
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

    test('Ambiance seçiliyken de video tam süre ve sessiz bölüm yok', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 300) < 0.3, `süre ${out.duration}`);
      assert.equal(isSilent(await channelStats(config.output.video, { start: 220, duration: 60 })), false);
    });
  });
});
