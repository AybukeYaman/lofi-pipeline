/**
 * Uçtan uca build, Pomodoro + AYRI çalışma/mola görüntüsü. Gerçek encode.
 *
 * Çalışma görüntüsü kırmızı bir döngü videosu, mola görüntüsü FARKLI boyutta
 * mavi bir resim: hem "oturum başına doğru görüntü", hem "iki ayrı kaynağın
 * aynı akış parametresine getirilmesi", hem de oturum sınırlarının kare
 * doğruluğu çıktı videosundan geri okunarak doğrulanıyor.
 *
 * İki yol: etiketsiz (gövde kopya + kuyruk encode) ve etiketli (tam encode).
 * 2 dk GET READY + 1/1 × 2 tur = 6 dakika, Pomodoro'nun birimi dakika olduğu için
 * en küçük kurulum. GET READY çalışma görüntüsünü kullanır.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { ffmpeg } from '../../core/ffmpeg.js';
import { probe } from '../../core/probe.js';
import { createWorkspace } from '../../core/workspace.js';
import { prepareVideo } from '../../steps/01-video-prep.js';
import { assembleVideo } from '../../steps/04-assemble.js';
import { DEFAULT_LABEL_FONT_FILE } from '../../steps/04a-label-overlay.js';
import { countFrames, makeTone, tempDir } from '../helpers/fixtures.js';

const W = 320;
const H = 180;

let hasFont = true;
try { await access(DEFAULT_LABEL_FONT_FILE); } catch { hasFont = false; }

/** Düz renkli döngü videosu (5 sn, 24 fps). */
async function makeSolidClip(path, color) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:r=24:d=5`,
    '-c:v', 'libx264', '-crf', '10', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-y', path,
  ]);
}

/** Düz renkli resim — çalışma görüntüsünden FARKLI boyutta (matchTo denensin). */
async function makeSolidImage(path, color) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `color=c=${color}:s=400x300`,
    '-frames:v', '1', '-update', '1', '-y', path,
  ]);
}

/**
 * Videonun `at` saniyesindeki sol alt köşenin ortalama rengi (etiket yazıları
 * sağ üstte, köşeye girmez). [r, g, b].
 */
function colorAt(video, at) {
  const run = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1',
    '-vf', 'crop=24:24:0:150,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer' });
  assert.equal(run.status, 0, run.stderr.toString());
  return [...run.stdout];
}

const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90;
const isBlue = ([r, g, b]) => b > 180 && r < 90 && g < 90;

/** Oturum sırası: GET READY 0-120, WORK 120-180, BREAK 180-240, WORK 240-300, BREAK 300-360. */
function assertSessionColors(video) {
  const expect = [
    [30, isRed, 'GET READY ortası (çalışma görüntüsü)'], [119.8, isRed, 'GET READY sonu'],
    [120.2, isRed, 'WORK 01 başı'], [150, isRed, 'WORK 01 ortası'], [179.8, isRed, 'WORK 01 sonu'],
    [180.2, isBlue, 'BREAK 01 başı'], [210, isBlue, 'BREAK 01 ortası'], [239.8, isBlue, 'BREAK 01 sonu'],
    [240.2, isRed, 'WORK 02 başı'], [270, isRed, 'WORK 02 ortası'], [299.8, isRed, 'WORK 02 sonu'],
    [300.2, isBlue, 'BREAK 02 başı'], [330, isBlue, 'BREAK 02 ortası'],
  ];
  for (const [at, check, name] of expect) {
    const color = colorAt(video, at);
    assert.ok(check(color), `${name} (${at} sn) yanlış renk: ${color}`);
  }
}

describe('build — Pomodoro: çalışma ve mola için ayrı görüntü', () => {
  let dir;

  const projectJson = (outDir, extra = {}) => ({
    clip: './work.mp4',
    audioDir: './audio',
    order: ['01-a.m4a', '02-b.m4a'],
    pomodoro: {
      enabled: true, workMinutes: 1, breakMinutes: 1, rounds: 2, breakClip: './break.png',
      // Bipler görüntüyü etkilemez; testi hızlandırmak için kapalı.
      countdownBeep: false, workStartSound: false, breakStartSound: false,
    },
    video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
    output: { dir: outDir },
    stream: { dir: null },
    ...extra,
  });

  before(async () => {
    dir = await tempDir('build-pomodoro-visuals');
    await mkdir(dir.path('audio'));
    await makeSolidClip(dir.path('work.mp4'), 'red');
    await makeSolidImage(dir.path('break.png'), 'blue');
    // Tam 360 sn müzik: timeline'la eşit (2 dk GET READY dahil), kırpma yok.
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 180, frequency: 220 });
    await makeTone(dir.path('audio/02-b.m4a'), { seconds: 180, frequency: 330 });
  });
  after(() => dir?.cleanup());

  describe('etiketsiz (gövde kopya + kuyruk encode)', () => {
    let config;
    let report;

    before(async () => {
      await writeFile(dir.path('plain.json'), JSON.stringify(projectJson('./out-plain')));
      config = await loadProject(dir.path('plain.json'));
      report = await runBuild(config, { render: true });
    });

    test('config mola görüntüsünün türünü uzantıdan türetir', () => {
      assert.equal(config.pomodoro.breakSource, 'image');
      assert.match(config.pomodoro.breakClip, /break\.png$/);
    });

    test('mola görüntüsü ayrı adımda, çalışma görüntüsünün boyutunda hazırlanır', () => {
      assert.deepEqual(report.steps.map((s) => s.tag), ['01', '01b', '02', '07', '04', '05']);
      const brk = report.details['01b'];
      assert.equal(brk.source.kind, 'image');
      assert.equal(brk.result.width, report.details['01'].result.width);
      assert.equal(brk.result.height, report.details['01'].result.height);
      assert.equal(brk.result.fps, report.details['01'].result.fps);
    });

    test('her oturum kendi görüntüsünü gösterir, sınırlar kare doğrulukta', () => {
      assertSessionColors(config.output.video);
    });

    test('yöntem gövde kopya + kuyruk encode; birleşme noktaları temiz', () => {
      const assemble = report.details['04'];
      assert.equal(assemble.method, 'copy-body+encode-tail');
      assert.equal(assemble.sessions.length, 5);
      assert.deepEqual(assemble.sessions.map((s) => s.kind), ['ready', 'work', 'break', 'work', 'break']);
      assert.deepEqual(assemble.sessions.map((s) => s.visual), ['work', 'work', 'break', 'work', 'break']);
      assert.ok(assemble.junctions.length >= 3, 'oturum geçişleri denetlenmedi');
      assert.deepEqual(assemble.junctions.filter((j) => !j.clean), []);
    });

    test('süre ve kare sayısı tam: 360 sn × 24 fps', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 360) < 0.2, `süre ${out.duration}`);
      assert.ok(Math.abs(await countFrames(config.output.video) - 360 * 24) <= 1);
    });
  });

  const maybe = hasFont ? describe : describe.skip;
  maybe('etiketli (tam encode: etiket gövdeyi kopyalatmaz)', () => {
    let config;
    let report;

    before(async () => {
      await writeFile(dir.path('labeled.json'), JSON.stringify(projectJson('./out-labeled', {
        labels: [{ id: 'durum', kind: 'pomodoro-status' }],
      })));
      config = await loadProject(dir.path('labeled.json'));
      report = await runBuild(config, { render: true });
    });

    test('yöntem tam encode, etiketler yanmış', () => {
      const assemble = report.details['04'];
      assert.equal(assemble.method, 'full-encode');
      assert.equal(assemble.labels, true);
      assert.equal(assemble.sessions.length, 5);
    });

    test('görüntüler etiketli videoda da oturumlara göre değişir', () => {
      assertSessionColors(config.output.video);
    });

    test('kare sayısı tam: fade ve etiketler oturum sınırlarını kaydırmaz', async () => {
      assert.ok(Math.abs(await countFrames(config.output.video) - 360 * 24) <= 1);
    });
  });

  describe('mola görüntüsü verilmezse', () => {
    test('config breakClip null, build tek görüntüyle çalışır (01b yok)', async () => {
      const json = projectJson('./out-single');
      delete json.pomodoro.breakClip;
      await writeFile(dir.path('single.json'), JSON.stringify(json));
      const config = await loadProject(dir.path('single.json'));
      assert.equal(config.pomodoro.breakClip, null);

      const report = await runBuild(config, { render: true });
      assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '04', '05']);
      assert.equal(report.details['04'].sessions, null);
      // Tek görüntü: baştan sona kırmızı.
      for (const at of [30, 150, 210, 270, 330]) assert.ok(isRed(colorAt(config.output.video, at)), `${at} sn`);
    });

    test('olmayan mola dosyası build\'den ÖNCE anlaşılır hatayla durur', async () => {
      const json = projectJson('./out-missing');
      json.pomodoro.breakClip = './yok.png';
      await writeFile(dir.path('missing.json'), JSON.stringify(json));
      await assert.rejects(loadProject(dir.path('missing.json')), /pomodoro\.breakClip/);
    });
  });

  describe('görüntülerin akış parametreleri uyuşmazsa', () => {
    test('her oturum yeniden encode edilip birleştirilir, yine doğru görüntü ve kare sayısı', async () => {
      const workspace = await createWorkspace();
      try {
        const base = async (name, clip, crf) => (await prepareVideo({
          clipPath: dir.path(clip), outputPath: dir.path(name), workspace,
          cropBottom: 0, cropFromConfig: true, loopTest: false, crf, preset: 'ultrafast',
        })).output;
        // Farklı crf → farklı SPS/PPS: kopyayla birleşmez (assemble.test.js'teki aynı tuzak).
        const work = await base('base-work.mp4', 'work.mp4', 16);
        const brk = await base('base-break.mp4', 'work.mp4', 30);
        const tone = await makeTone(dir.path('tone20.m4a'), { seconds: 20 });
        const warnings = [];

        const report = await assembleVideo({
          videoPath: work,
          audioPath: tone,
          outputPath: dir.path('mixed.mp4'),
          workspace,
          crf: 16,
          preset: 'ultrafast',
          fadeOut: 0,
          sessionVideo: {
            breakVideoPath: brk,
            sessions: [
              { kind: 'work', startSeconds: 0, endSeconds: 8 },
              { kind: 'break', startSeconds: 8, endSeconds: 14 },
              { kind: 'work', startSeconds: 14, endSeconds: 20 },
            ],
          },
          logger: { info() {}, warn: (m) => warnings.push(m) },
        });

        assert.equal(report.method, 'encode-sessions');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /yeniden encode/);
        assert.equal(await countFrames(report.output), 20 * 24);
        assert.deepEqual(report.junctions.filter((j) => !j.clean), []);
      } finally {
        await workspace.cleanup();
      }
    });
  });
});
