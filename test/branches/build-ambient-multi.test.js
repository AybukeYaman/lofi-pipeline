/**
 * Çoklu Ambiance: iki ortam sesi, iki mod (layer / sequence).
 *
 * Doğrulanan şeyler:
 *   - Ambiance müzikten KISA olsa da videonun tamamını kaplar (döngü) ve
 *     videodan uzun olsa da müzik süresinde kesilir.
 *   - layer modunda parça başına bir döngü birimi, sequence modunda tek birim.
 *   - Döngü birimi dikişsiz üretilir (kuyruk başa harmanlanmış).
 *   - Parça başına volumeDb uygulanır.
 *
 * Gerçek encode, küçük yapay veriyle.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { ffmpeg } from '../../core/ffmpeg.js';
import { probe } from '../../core/probe.js';
import { makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

/** Müzik süresi: 8 + 7 = 15 sn. İki ambient de bundan kısa → döngü şart. */
const MUSIC_SECONDS = 15;

/** @param {string} dir */
async function makeWorkspace(dir) {
  await mkdir(dir.path('audio'));
  await makeDriftingClip(dir.path('clip.mp4'), { width: 640, height: 360 });
  await makeTone(dir.path('audio/01-a.m4a'), { seconds: 8, frequency: 440 });
  await makeTone(dir.path('audio/02-b.m4a'), { seconds: 7, frequency: 660 });
  // İki ambient, farklı uzunlukta ve farklı örnekleme hızında: aresample ve
  // harman kısaltması birlikte sınanıyor.
  await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:d=4:a=0.3',
    '-ac', '2', '-ar', '44100', '-y', dir.path('amb-rain.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=color=brown:d=3:a=0.3',
    '-ac', '2', '-ar', '48000', '-y', dir.path('amb-fire.wav')]);
}

describe('build — iki Ambiance, layer modu', () => {
  let dir;
  let report;
  let config;

  before(async () => {
    dir = await tempDir('build-ambient-layer');
    await makeWorkspace(dir);
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      ambient: {
        mode: 'layer',
        crossfade: 1,
        tracks: ['./amb-rain.wav', { path: './amb-fire.wav', volumeDb: -26 }],
      },
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
    }));
    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('konfig planı tanıdı: iki parça, parça ofseti korundu', () => {
    assert.equal(config.ambient.mode, 'layer');
    assert.equal(config.ambient.crossfade, 1);
    assert.deepEqual(config.ambient.tracks.map((t) => t.volumeDb), [null, -26]);
  });

  test('çıktı müzik süresinde — Ambiance kısa olsa da boşluk yok', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - MUSIC_SECONDS) < 0.1, `süre ${out.duration}`);
    assert.equal(out.hasAudio, true);
  });

  test('adım sırası değişmedi: tek ambient adımı, tek montaj', () => {
    assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '03', '04', '05']);
    assert.equal(report.steps.filter((s) => s.tag === '03').length, 1);
  });

  test('layer: parça başına bağımsız, dikişsiz döngü birimi', () => {
    const d = report.details['03'];
    assert.equal(d.mode, 'layer');
    assert.equal(d.tracks.length, 2);
    assert.equal(d.loops.length, 2);
    for (const loop of d.loops) {
      assert.equal(loop.seamless, true, 'döngü birimi harmanlanmış olmalı');
      assert.ok(loop.crossfade > 0, `harman ${loop.crossfade}`);
      // Birim = kaynak − harman: dikiş birimin içine alındı.
      assert.ok(loop.duration > 0 && loop.duration < 4, `birim süresi ${loop.duration}`);
    }
  });

  test('parça ofsetleri ayrı ayrı hedefe çevrildi', () => {
    const [rain, fire] = report.details['03'].tracks;
    assert.equal(rain.offsetDb, config.audio.ambientOffsetDb);
    assert.equal(fire.offsetDb, -26);
    assert.ok(fire.targetI < rain.targetI, 'daha düşük ofset daha sessiz hedef');
  });

  test('44.1 kHz parça müziğin hızına çevrildi', () => {
    const rain = report.details['03'].tracks[0];
    assert.equal(rain.sampleRate, 44100);
    assert.equal(rain.resampledTo, 48000);
  });

  test('raporda plan görünür, ambient alanı düz metin kaldı', () => {
    assert.equal(report.ambient, 'mixed');
    assert.equal(report.ambientPlan.mode, 'layer');
    assert.equal(report.ambientPlan.tracks.length, 2);
  });
});

describe('build — iki Ambiance, sequence modu', () => {
  let dir;
  let report;
  let config;

  before(async () => {
    dir = await tempDir('build-ambient-sequence');
    await makeWorkspace(dir);
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      ambient: { mode: 'sequence', crossfade: 1, tracks: ['./amb-rain.wav', './amb-fire.wav'] },
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
    }));
    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('sequence: bütün parçalar tek döngü birimine girer', () => {
    const d = report.details['03'];
    assert.equal(d.mode, 'sequence');
    assert.equal(d.tracks.length, 2);
    assert.equal(d.loops.length, 1);
    assert.deepEqual(d.loops[0].source.length, 2, 'tur iki parçayı da içerir');
    assert.equal(d.loops[0].seamless, true);
  });

  test('tur süresi parçaların harmanla kısalmış toplamı', () => {
    // 4 + 3 = 7 sn, aralarında 1 sn harman → 6 sn tur, dikiş harmanı −1 → ~5 sn.
    const unit = report.details['03'].loops[0].duration;
    assert.ok(Math.abs(unit - 5) < 0.6, `birim süresi ${unit}`);
  });

  test('çıktı yine müzik süresinde', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - MUSIC_SECONDS) < 0.1, `süre ${out.duration}`);
  });
});

describe('build — Ambiance videodan UZUN', () => {
  let dir;
  let config;

  before(async () => {
    dir = await tempDir('build-ambient-long');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 640, height: 360 });
    // Müzik 4 sn, ambient 20 sn → ambient kesilmeli.
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 4, frequency: 440 });
    await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:d=20:a=0.3',
      '-ac', '2', '-ar', '48000', '-y', dir.path('amb-long.wav')]);
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4', audioDir: './audio', ambient: './amb-long.wav',
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 1 },
      output: { dir: './out' },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
    }));
    config = await loadProject(dir.path('project.json'));
    await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('çıktı müzik süresinde kalır, ambient onu uzatmaz', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 4) < 0.1, `süre ${out.duration}`);
  });
});
