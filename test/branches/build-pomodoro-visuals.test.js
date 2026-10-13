/**
 * Uçtan uca build, Pomodoro + HER DURUM İÇİN AYRI görüntü. Gerçek encode.
 *
 * Döngü: STUDY (görüntüsü yok → ana görüntü, kırmızı döngü videosu), STRETCH
 * (yeşil resim), BREAK (mavi resim); GET READY'nin kendi görüntüsü var (sarı
 * resim). Resimler ana görüntüden FARKLI boyutta: hem "oturum başına doğru
 * görüntü", hem "ayrı kaynakların aynı akış parametresine getirilmesi", hem de
 * oturum sınırlarının kare doğruluğu çıktı videosundan geri okunarak doğrulanıyor.
 *
 * İki yol: etiketsiz (gövde kopya + kuyruk encode) ve etiketli (tam encode).
 * 2 dk GET READY + (1+1+1 dk) × 2 tur = 8 dakika.
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

/** Düz renkli resim — ana görüntüden FARKLI boyutta (matchTo denensin). */
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
const isGreen = ([r, g, b]) => g > 180 && r < 90 && b < 90;
const isYellow = ([r, g, b]) => r > 180 && g > 180 && b < 90;

/**
 * Oturum sırası: GET READY 0-120 (sarı), STUDY 120-180 (kırmızı), STRETCH 180-240 (yeşil),
 * BREAK 240-300 (mavi), sonra aynı döngü ikinci kez: 300-360, 360-420, 420-480.
 */
function assertSessionColors(video) {
  const expect = [
    [30, isYellow, 'GET READY ortası (kendi görüntüsü)'], [119.8, isYellow, 'GET READY sonu'],
    [120.2, isRed, 'STUDY 01 başı (ana görüntü)'], [150, isRed, 'STUDY 01 ortası'], [179.8, isRed, 'STUDY 01 sonu'],
    [180.2, isGreen, 'STRETCH 01 başı'], [210, isGreen, 'STRETCH 01 ortası'], [239.8, isGreen, 'STRETCH 01 sonu'],
    [240.2, isBlue, 'BREAK 01 başı'], [270, isBlue, 'BREAK 01 ortası'], [299.8, isBlue, 'BREAK 01 sonu'],
    [300.2, isRed, 'STUDY 02 başı'], [330, isRed, 'STUDY 02 ortası'], [359.8, isRed, 'STUDY 02 sonu'],
    [360.2, isGreen, 'STRETCH 02 başı'], [390, isGreen, 'STRETCH 02 ortası'], [419.8, isGreen, 'STRETCH 02 sonu'],
    [420.2, isBlue, 'BREAK 02 başı'], [450, isBlue, 'BREAK 02 ortası'], [477.5, isBlue, 'BREAK 02 sonu (kararmadan önce)'],
  ];
  for (const [at, check, name] of expect) {
    const color = colorAt(video, at);
    assert.ok(check(color), `${name} (${at} sn) yanlış renk: ${color}`);
  }
}

describe('build — Pomodoro: her durum için ayrı görüntü', () => {
  let dir;

  const projectJson = (outDir, extra = {}) => ({
    clip: './work.mp4',
    audioDir: './audio',
    order: ['01-a.m4a', '02-b.m4a'],
    pomodoro: {
      enabled: true,
      rounds: 2,
      statuses: [
        { name: 'STUDY', minutes: 1 },
        { name: 'STRETCH', minutes: 1, visual: './stretch.png' },
        { name: 'BREAK', minutes: 1, visual: './break.png' },
      ],
      intro: { visual: './ready.png' },
      // Bipler görüntüyü etkilemez; testi hızlandırmak için kapalı.
      countdownBeep: false,
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
    await makeSolidImage(dir.path('stretch.png'), 'lime');
    await makeSolidImage(dir.path('ready.png'), 'yellow');
    // Tam 480 sn müzik: timeline'la eşit (2 dk GET READY dahil), kırpma yok.
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 240, frequency: 220 });
    await makeTone(dir.path('audio/02-b.m4a'), { seconds: 240, frequency: 330 });
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

    test('config her görüntünün yolunu çözer ve türünü uzantıdan türetir', () => {
      const { statuses, intro } = config.pomodoro;
      assert.deepEqual(statuses.map((x) => x.visualSource), [null, 'image', 'image']);
      assert.equal(statuses[0].visual, null);
      assert.match(statuses[1].visual, /stretch\.png$/);
      assert.match(statuses[2].visual, /break\.png$/);
      assert.equal(intro.visualSource, 'image');
      assert.match(intro.visual, /ready\.png$/);
    });

    test('her farklı görüntü tek adımda, ana görüntünün boyutunda hazırlanır', () => {
      assert.deepEqual(report.steps.map((x) => x.tag), ['01', '01b', '02', '07', '04', '05']);
      const { items } = report.details['01b'];
      assert.equal(items.length, 3);
      for (const item of items) {
        assert.equal(item.source.kind, 'image');
        assert.equal(item.result.width, report.details['01'].result.width);
        assert.equal(item.result.height, report.details['01'].result.height);
        assert.equal(item.result.fps, report.details['01'].result.fps);
      }
    });

    test('her oturum kendi görüntüsünü gösterir, sınırlar kare doğrulukta', () => {
      assertSessionColors(config.output.video);
    });

    test('yöntem gövde kopya + kuyruk encode; birleşme noktaları temiz', () => {
      const assemble = report.details['04'];
      assert.equal(assemble.method, 'copy-body+encode-tail');
      assert.equal(assemble.sessions.length, 7);
      assert.deepEqual(
        assemble.sessions.map((x) => x.kind),
        ['ready', 'status', 'status', 'status', 'status', 'status', 'status'],
      );
      const visuals = assemble.sessions.map((x) => x.visual);
      assert.match(visuals[0], /ready\.png$/);
      assert.equal(visuals[1], 'main');
      assert.match(visuals[2], /stretch\.png$/);
      assert.match(visuals[3], /break\.png$/);
      assert.deepEqual(visuals.slice(4), [visuals[1], visuals[2], visuals[3]]);
      assert.ok(assemble.junctions.length >= 3, 'oturum geçişleri denetlenmedi');
      assert.deepEqual(assemble.junctions.filter((j) => !j.clean), []);
    });

    test('süre ve kare sayısı tam: 480 sn × 24 fps', async () => {
      const out = await probe(config.output.video);
      assert.ok(Math.abs(out.duration - 480) < 0.2, `süre ${out.duration}`);
      assert.ok(Math.abs(await countFrames(config.output.video) - 480 * 24) <= 1);
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
      assert.equal(assemble.sessions.length, 7);
    });

    test('görüntüler etiketli videoda da oturumlara göre değişir', () => {
      assertSessionColors(config.output.video);
    });

    test('kare sayısı tam: fade ve etiketler oturum sınırlarını kaydırmaz', async () => {
      assert.ok(Math.abs(await countFrames(config.output.video) - 480 * 24) <= 1);
    });
  });

  describe('görüntü verilmezse', () => {
    test('hiçbir durumun görüntüsü yoksa build tek görüntüyle çalışır (01b yok)', async () => {
      const json = projectJson('./out-single');
      json.pomodoro.statuses = [{ name: 'STUDY', minutes: 1 }, { name: 'BREAK', minutes: 1 }];
      delete json.pomodoro.intro;
      await writeFile(dir.path('single.json'), JSON.stringify(json));
      const config = await loadProject(dir.path('single.json'));
      assert.equal(config.pomodoro.intro.visual, null);
      assert.deepEqual(config.pomodoro.statuses.map((x) => x.visual), [null, null]);

      const report = await runBuild(config, { render: true });
      assert.deepEqual(report.steps.map((x) => x.tag), ['01', '02', '07', '04', '05']);
      assert.equal(report.details['04'].sessions, null);
      // Tek görüntü: baştan sona kırmızı.
      for (const at of [30, 150, 210, 270, 330]) assert.ok(isRed(colorAt(config.output.video, at)), `${at} sn`);
    });

    test('olmayan durum görüntüsü build öncesi anlaşılır hatayla durur', async () => {
      const json = projectJson('./out-missing');
      json.pomodoro.statuses[1].visual = './yok.png';
      await writeFile(dir.path('missing.json'), JSON.stringify(json));
      await assert.rejects(loadProject(dir.path('missing.json')), /pomodoro\.statuses\[1\]\.visual/);
    });

    test('olmayan GET READY görüntüsü de build öncesi durur', async () => {
      const json = projectJson('./out-missing-intro');
      json.pomodoro.intro.visual = './yok.png';
      await writeFile(dir.path('missing-intro.json'), JSON.stringify(json));
      await assert.rejects(loadProject(dir.path('missing-intro.json')), /pomodoro\.intro\.visual/);
    });
  });

  describe('görüntü ana klibin kendisiyse', () => {
    test('ayrı base üretilmez; ana base kullanılır, renkler yine doğru', async () => {
      await mkdir(dir.path('audio2'));
      await makeTone(dir.path('audio2/01-a.m4a'), { seconds: 240, frequency: 220 });
      const json = projectJson('./out-main');
      json.audioDir = './audio2';
      json.order = ['01-a.m4a'];
      json.pomodoro = {
        enabled: true,
        rounds: 1,
        statuses: [
          { name: 'STUDY', minutes: 1, visual: './work.mp4' },
          { name: 'BREAK', minutes: 1, visual: './break.png' },
        ],
        countdownBeep: false,
      };
      await writeFile(dir.path('main.json'), JSON.stringify(json));
      const config = await loadProject(dir.path('main.json'));
      const report = await runBuild(config, { render: true });

      // Yalnızca BREAK'in resmi hazırlanır; STUDY ana klibi kullanır.
      assert.equal(report.details['01b'].items.length, 1);
      assert.match(report.details['01b'].items[0].visual, /break.png$/);
      assert.equal(report.details['04'].sessions.length, 3);
      for (const [at, check, name] of [
        [60, isRed, 'GET READY (ana görüntü)'], [150, isRed, 'STUDY (ana klibin kendisi)'], [210, isBlue, 'BREAK'],
      ]) assert.ok(check(colorAt(config.output.video, at)), name);
    });
  });

  describe('eski project.json şekli', () => {
    test('workMinutes/breakMinutes/breakClip okunur: BREAK kendi görüntüsünü alır', async () => {
      const json = projectJson('./out-legacy');
      json.pomodoro = { enabled: true, workMinutes: 1, breakMinutes: 1, rounds: 2, breakClip: './break.png' };
      await writeFile(dir.path('legacy.json'), JSON.stringify(json));
      const config = await loadProject(dir.path('legacy.json'));
      assert.deepEqual(config.pomodoro.statuses.map((x) => [x.name, x.minutes]), [['STUDY', 1], ['BREAK', 1]]);
      assert.equal(config.pomodoro.statuses[0].visual, null);
      assert.match(config.pomodoro.statuses[1].visual, /break\.png$/);
      assert.equal(config.pomodoro.statuses[1].visualSource, 'image');
      assert.equal('breakClip' in config.pomodoro, false);
    });
  });

  describe('iki setli program (set tekrarı + uzun mola)', () => {
    let config;
    let report;

    // SET 1 × 2 = (STUDY sarı + BREAK mavi) iki kez, SET 2 = STUDY sarı + LONG BREAK yeşil; 1 tur.
    // GET READY 0-120 (ana: kırmızı), STUDY 120-180, BREAK 180-240, STUDY 240-300, BREAK 300-360,
    // STUDY 360-420, LONG BREAK 420-480.
    before(async () => {
      await makeSolidImage(dir.path('study.png'), 'yellow');
      const json = projectJson('./out-sets');
      json.pomodoro = {
        enabled: true,
        rounds: 1,
        sets: [
          { repeat: 2, steps: [{ name: 'STUDY', minutes: 1, visual: './study.png' }, { name: 'BREAK', minutes: 1, visual: './break.png' }] },
          { steps: [{ name: 'STUDY', minutes: 1, visual: './study.png' }, { name: 'LONG BREAK', minutes: 1, visual: './stretch.png' }] },
        ],
        countdownBeep: false,
      };
      await writeFile(dir.path('sets.json'), JSON.stringify(json));
      config = await loadProject(dir.path('sets.json'));
      report = await runBuild(config, { render: true });
    });

    test('config setleri ve açılmış adım listesini taşır', () => {
      assert.deepEqual(config.pomodoro.sets.map((set) => [set.name, set.repeat]), [['SET 1', 2], ['SET 2', 1]]);
      assert.deepEqual(config.pomodoro.statuses.map((x) => x.name), ['STUDY', 'BREAK', 'STUDY', 'BREAK', 'STUDY', 'LONG BREAK']);
      assert.deepEqual(report.pomodoroPlan.sets.map((set) => set.steps.map((s) => s.kind)), [['work', 'break'], ['work', 'break']]);
    });

    test('aynı görüntüyü kullanan adımlar tek base paylaşır (3 farklı görüntü)', () => {
      assert.equal(report.details['01b'].items.length, 3);
      const visuals = report.details['04'].sessions.map((x) => x.visual);
      assert.equal(visuals.length, 7);
      assert.equal(visuals[0], 'main');
      assert.equal(new Set([visuals[1], visuals[3], visuals[5]]).size, 1, 'üç STUDY aynı görüntü');
      assert.equal(visuals[2], visuals[4], 'iki BREAK aynı görüntü');
    });

    test('oturum sırası ve renkler videodan okunur; sınırlar kare doğrulukta', async () => {
      const expect = [
        [60, isRed, 'GET READY (ana görüntü)'], [119.8, isRed, 'GET READY sonu'],
        [120.2, isYellow, 'STUDY 01 başı'], [179.8, isYellow, 'STUDY 01 sonu'],
        [180.2, isBlue, 'BREAK 01 başı'], [239.8, isBlue, 'BREAK 01 sonu'],
        [240.2, isYellow, 'STUDY 02 başı (SET 1 ikinci tekrar)'], [299.8, isYellow, 'STUDY 02 sonu'],
        [300.2, isBlue, 'BREAK 02 başı'], [359.8, isBlue, 'BREAK 02 sonu'],
        [360.2, isYellow, 'STUDY 03 başı (SET 2)'], [419.8, isYellow, 'STUDY 03 sonu'],
        [420.2, isGreen, 'LONG BREAK 01 başı'], [450, isGreen, 'LONG BREAK 01 ortası'], [477.5, isGreen, 'LONG BREAK 01 sonu (kararmadan önce)'],
      ];
      for (const [at, check, name] of expect) {
        const color = colorAt(config.output.video, at);
        assert.ok(check(color), `${name} (${at} sn) yanlış renk: ${color}`);
      }
      assert.ok(Math.abs(await countFrames(config.output.video) - 480 * 24) <= 1);
      assert.deepEqual(report.details['04'].junctions.filter((j) => !j.clean), []);
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
        const third = await base('base-third.mp4', 'work.mp4', 24);
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
            bases: { brk, third },
            sessions: [
              { kind: 'status', visual: null, startSeconds: 0, endSeconds: 8 },
              { kind: 'status', visual: 'brk', startSeconds: 8, endSeconds: 14 },
              { kind: 'status', visual: 'third', startSeconds: 14, endSeconds: 20 },
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
