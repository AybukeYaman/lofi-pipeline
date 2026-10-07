/**
 * Uçtan uca build, ambient'li: ses birleştirme → ambient (yalnız sese) →
 * montaj (gövde kopya + fade'li kuyruk). Gerçek encode, küçük yapay veriyle.
 */

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { ffmpeg } from '../../core/ffmpeg.js';
import { measureLoudness } from '../../core/loudness.js';
import { probe } from '../../core/probe.js';
import { extractFrame, makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

describe('build — ambient sese karışır, video bir kez yazılır', () => {
  let dir;
  let report;
  let config;

  before(async () => {
    dir = await tempDir('build-ambient');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 640, height: 360 });
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 8, frequency: 440 });
    await makeTone(dir.path('audio/02-b.m4a'), { seconds: 7, frequency: 660 });
    // Ambient: sürekli pembe gürültü (loop'lanır).
    await ffmpeg(['-f', 'lavfi', '-i', 'anoisesrc=color=pink:d=4:a=0.3', '-ac', '2', '-ar', '44100', '-y', dir.path('amb.wav')]);
    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4', audioDir: './audio', ambient: './amb.wav',
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
    }));
    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('çıktı müzik süresinde, sesli ve 16:9', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 15) < 0.1, `süre ${out.duration}`);
    assert.equal(out.hasAudio, true);
    assert.deepEqual([out.width, out.height], [640, 360]);
  });

  test('adım sırası: ses → ambient → montaj; montaj gövdeyi kopyalar', () => {
    assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '03', '04', '05']);
    assert.equal(report.details['04'].method, 'copy-body+encode-tail');
  });

  test('video sonunda kararır (fade korunuyor)', async () => {
    const last = await extractFrame(config.output.video, 15 * 24 - 1, dir.path('last.png'));
    const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', last, '-vf', 'signalstats,metadata=print', '-f', 'null', '-']);
    const yavg = Number(/YAVG=([\d.]+)/.exec(stderr)?.[1]);
    assert.ok(yavg < 25, `son kare parlaklığı ${yavg}`);
  });

  test('karışık ses ölçülebilir (bozuk akış yok)', async () => {
    const mixed = await measureLoudness(config.output.video, { startSeconds: 2, duration: 6 });
    assert.ok(Number.isFinite(mixed.inputI));
  });
});
