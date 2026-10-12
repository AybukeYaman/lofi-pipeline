/**
 * Uçtan uca build, video üstü yazılı: project.json `labels` → config → 04a →
 * 04 montaj. Gerçek encode, küçük yapay veriyle.
 *
 * İddialar: etiket yoksa eski hızlı yol aynen; etiket varsa tam encode ve yazı
 * çıktıda görünür, süre/ses/fade bozulmaz.
 */

import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { ffmpeg } from '../../core/ffmpeg.js';
import { probe } from '../../core/probe.js';
import { DEFAULT_LABEL_FONT_FILE } from '../../steps/04a-label-overlay.js';
import { extractFrame, makeDriftingClip, makeTone, ssim, tempDir } from '../helpers/fixtures.js';

let hasFont = true;
try { await access(DEFAULT_LABEL_FONT_FILE); } catch { hasFont = false; }
const maybe = hasFont ? describe : describe.skip;

maybe('build — video üstü yazılar', () => {
  let dir;
  let plain;
  let labelled;

  /** Aynı girdiyle iki proje: yalnızca `labels` alanı farklı. */
  async function build(name, extra) {
    await mkdir(dir.path(`${name}/audio`), { recursive: true });
    await makeTone(dir.path(`${name}/audio/01-a.m4a`), { seconds: 8, frequency: 440 });
    await makeTone(dir.path(`${name}/audio/02-b.m4a`), { seconds: 7, frequency: 660 });
    await writeFile(dir.path(`${name}/project.json`), JSON.stringify({
      clip: '../clip.mp4', audioDir: './audio',
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      // Testler canlı yayın klasörüne albüm yazmasın.
      stream: { dir: null },
      ...extra,
    }));
    const config = await loadProject(dir.path(`${name}/project.json`));
    const report = await runBuild(config, { render: true });
    return { config, report };
  }

  before(async () => {
    dir = await tempDir('build-labels');
    await makeDriftingClip(dir.path('clip.mp4'), { width: 640, height: 360 });
    plain = await build('plain', {});
    labelled = await build('labelled', {
      labels: [{ id: 'a', text: 'MERHABA', x: 0.5, y: 0.5, size: 0.2 }],
    });
  });
  after(() => dir?.cleanup());

  test('yazı yokken montaj eski hızlı yolda: gövde kopya + kuyruk encode', () => {
    assert.equal(plain.report.details['04'].method, 'copy-body+encode-tail');
    assert.equal(plain.report.labels, 0);
  });

  test('yazı varken tam encode ve rapor yazı sayısını verir', () => {
    assert.equal(labelled.report.details['04'].method, 'full-encode');
    assert.equal(labelled.report.details['04'].labels, true);
    assert.equal(labelled.report.labels, 1);
  });

  test('süre, ses ve çözünürlük yazısız build ile aynı', async () => {
    const a = await probe(plain.config.output.video);
    const b = await probe(labelled.config.output.video);
    assert.ok(Math.abs(a.duration - b.duration) < 0.1, `${a.duration} / ${b.duration}`);
    assert.equal(b.hasAudio, true);
    assert.deepEqual([b.width, b.height], [a.width, a.height]);
  });

  test('yazı çıktıda görünür: aynı karenin yazılı hâli yazısızdan farklı', async () => {
    await extractFrame(plain.config.output.video, 100, dir.path('p.png'));
    await extractFrame(labelled.config.output.video, 100, dir.path('l.png'));
    const similarity = await ssim(dir.path('p.png'), dir.path('l.png'));
    assert.ok(similarity < 0.99, `kareler aynı görünüyor (SSIM ${similarity})`);
  });

  test('yazı da videoyla birlikte söner (fade etiketlerden SONRA)', async () => {
    const last = await extractFrame(labelled.config.output.video, 15 * 24 - 1, dir.path('last.png'));
    const { stderr } = await ffmpeg(['-loglevel', 'info', '-i', last, '-vf', 'signalstats,metadata=print', '-f', 'null', '-']);
    const yavg = Number(/YAVG=([\d.]+)/.exec(stderr)?.[1]);
    assert.ok(yavg < 25, `son kare parlaklığı ${yavg}`);
  });
});
