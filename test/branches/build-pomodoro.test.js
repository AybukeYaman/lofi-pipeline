/**
 * Uçtan uca build, Pomodoro açık: doğrulama → fazla müziğin kırpılması →
 * işaret seslerinin timeline'a bindirilmesi → montaj. Gerçek encode.
 *
 * Spec'teki Test 2 (fazla müzik kırpılır) ve Test 5 (her oturumun son 3
 * saniyesinde 3 bip — GET READY ve videonun sonu dahil, başlangıç sesi YOK)
 * burada ölçülerek doğrulanıyor: bipler nihai videodan geri okunuyor, filtre
 * metnine bakılarak değil.
 *
 * Süreler dakika cinsinden olmak zorunda (Pomodoro'nun birimi bu), o yüzden
 * en küçük anlamlı kurulum seçildi: 2 dk GET READY + 1/1 × 2 tur = 6 dakika.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { ffmpeg } from '../../core/ffmpeg.js';
import { probe } from '../../core/probe.js';
import { findOnsets, makeDriftingClip, tempDir } from '../helpers/fixtures.js';

/**
 * Kısık sesli müzik parçası.
 *
 * Neden kısık: işaret sesleri müziğin ÜSTÜNE biniyor ve testin onları
 * müzikten ayırt edebilmesi gerekiyor. Müzik tepe -26 dB, işaretler -3 dB'ye
 * ayarlanınca genlik eşiğiyle ayrılabiliyorlar.
 */
async function makeQuietTone(path, { seconds, frequency }) {
  await ffmpeg([
    '-f', 'lavfi', '-i', `sine=f=${frequency}:d=${seconds}:sample_rate=48000`,
    '-af', 'volume=-26dB',
    '-ac', '2', '-c:a', 'aac', '-b:a', '192k',
    '-y', path,
  ]);
  return path;
}

describe('build — Pomodoro: kırpma, oturumlar ve işaret sesleri', () => {
  let dir;
  let report;
  let config;

  /**
   * İşaretleri müzikten ayıran genlik eşiği, raporun kendi ölçümünden türetilir.
   * Sabit bir sayı yazmak kırılgan olurdu: müziğin tepe seviyesi encode
   * ayarlarına göre değişiyor, işaretler ise ondan `cue.volumeDb` kadar uzakta.
   * Eşik ikisinin ortasına (müziğin 6 dB üstü) konuyor.
   */
  const onsetOptions = () => ({
    threshold: 10 ** ((report.details['06'].musicPeakDb + 6) / 20),
    // Geri sayım beep'leri 1 sn arayla; birleşmesinler.
    minGapSeconds: 0.5,
  });

  before(async () => {
    dir = await tempDir('build-pomodoro');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 320, height: 180 });

    // 4 × 100 sn = 400 sn müzik, 360 sn timeline (2 dk GET READY + 4 dk) → 40 sn fazla.
    await makeQuietTone(dir.path('audio/01-a.m4a'), { seconds: 100, frequency: 220 });
    await makeQuietTone(dir.path('audio/02-b.m4a'), { seconds: 100, frequency: 330 });
    await makeQuietTone(dir.path('audio/03-c.m4a'), { seconds: 100, frequency: 440 });
    await makeQuietTone(dir.path('audio/04-d.m4a'), { seconds: 100, frequency: 550 });

    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      order: ['01-a.m4a', '02-b.m4a', '03-c.m4a', '04-d.m4a'],
      pomodoro: {
        enabled: true,
        // STUDY'nin bitişinde bip YOK (beep: false); GET READY ve BREAK'in (videonun sonu dahil) var.
        statuses: [{ name: 'STUDY', minutes: 1, beep: false }, { name: 'BREAK', minutes: 1 }],
        rounds: 2,
        // Fazla 40 sn soru sorulmadan, otomatik kesilir.
        // İşaretleri müziğin üstünde net duyulur yap: ölçüm eşiği ayırabilsin.
        cue: { volumeDb: 12 },
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

  test('çıktı Pomodoro timeline süresinde (360 sn), müzik süresinde değil', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 360) < 0.2, `süre ${out.duration}`);
  });

  test('adım sırası: ses → işaretler → montaj (Ambiance yok, 03 atlandı)', () => {
    assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '06', '04', '05']);
  });

  test('Test 2 — fazla 40 sn son parçadan kırpıldı, orijinal dosya değişmedi', async () => {
    const { trim, comparison } = report.pomodoroPlan;
    assert.equal(comparison.status, 'excess');
    assert.equal(Math.round(comparison.excessSeconds), 40);
    assert.equal(trim.trimmedCount, 1);
    assert.equal(trim.droppedCount, 0);
    assert.deepEqual(trim.tracks.map((t) => Math.round(t.usedDuration)), [100, 100, 100, 60]);

    // Kırpma yalnızca render'da: kaynak dosya hâlâ 100 saniye.
    const source = await probe(dir.path('audio/04-d.m4a'));
    assert.ok(Math.abs(source.duration - 100) < 0.2, `kaynak ${source.duration}`);
  });

  test('tracklist kırpılmış süreye göre damgalanır', async () => {
    const text = await readFile(config.output.tracklist, 'utf8');
    assert.deepEqual(text.trim().split('\n').map((line) => line.split('  ')[0]), ['0:00', '1:40', '3:20', '5:00']);
  });

  test('timeline dosyası GET READY + STUDY/BREAK dökümünü verir', async () => {
    const text = await readFile(config.output.pomodoroTimeline, 'utf8');
    assert.equal(text.trim(), [
      'GET READY', '00:00 - 02:00', '',
      'STUDY 01', '02:00 - 03:00', '',
      'BREAK 01', '03:00 - 04:00', '',
      'STUDY 02', '04:00 - 05:00', '',
      'BREAK 02', '05:00 - 06:00',
    ].join('\n'));
  });

  test('Test 5 — her oturumun son 3 saniyesinde 3 bip (beep: false hariç): GET READY, mola ve videonun sonu', async () => {
    const { onsets } = await findOnsets(config.output.video, { dir, ...onsetOptions() });

    // 5 oturum (GET READY 0-120, STUDY 120-180, BREAK 180-240, STUDY 240-300, BREAK 300-360).
    // Başlangıç sesi YOK: yalnızca her oturumun bitişinden önceki 3 bip; STUDY'de beep kapalı.
    const expected = [
      117, 118, 119,   // GET READY'nin 2. dakikasının son 3 sn'si
      237, 238, 239,   // BREAK 01
      357, 358, 359,   // BREAK 02 = videonun son 3 sn'si (ses kararması bipleri kısmaz)
    ];
    assert.equal(onsets.length, expected.length, `bulunan işaretler: ${onsets.map((o) => o.toFixed(2))}`);
    for (const [i, at] of expected.entries()) {
      assert.ok(
        Math.abs(onsets[i] - at) < 0.2,
        `bip ${i}: ${onsets[i].toFixed(2)} sn, beklenen ${at} sn`,
      );
    }
  });

  test('bipler tam 1 saniye arayla ve videonun başında ses yok', async () => {
    const { onsets } = await findOnsets(config.output.video, { dir, ...onsetOptions() });
    for (let group = 0; group < onsets.length; group += 3) {
      assert.ok(Math.abs((onsets[group + 1] - onsets[group]) - 1) < 0.05, `${group}. grup`);
      assert.ok(Math.abs((onsets[group + 2] - onsets[group + 1]) - 1) < 0.05, `${group}. grup`);
    }
    assert.ok(onsets[0] > 100, `ilk bip GET READY'nin sonunda olmalı (${onsets[0].toFixed(2)} sn)`);
  });

  test('raporda plan, oturumlar ve işaret sayısı var', () => {
    assert.equal(report.pomodoro, 'applied');
    assert.equal(report.pomodoroPlan.rounds, 2);
    assert.equal(report.pomodoroPlan.totalSeconds, 360);
    assert.deepEqual(report.pomodoroPlan.sessions.map((s) => s.label), [
      'GET READY', 'STUDY 01', 'BREAK 01', 'STUDY 02', 'BREAK 02',
    ]);
    assert.deepEqual(report.pomodoroPlan.statuses, [
      { name: 'STUDY', minutes: 1, beep: false }, { name: 'BREAK', minutes: 1, beep: true },
    ]);
    // 3 bipli oturum (GET READY + 2 BREAK) × 3 bip
    assert.equal(report.pomodoroPlan.cueEvents, 9);
  });
});

describe('build — Pomodoro: iki setli program, bipler set sırasını izler', () => {
  let dir;
  let report;
  let config;

  before(async () => {
    dir = await tempDir('build-pomodoro-sets');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 320, height: 180 });
    // 480 sn müzik = 480 sn timeline: kırpma yok.
    await makeQuietTone(dir.path('audio/01-a.m4a'), { seconds: 240, frequency: 220 });
    await makeQuietTone(dir.path('audio/02-b.m4a'), { seconds: 240, frequency: 330 });

    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      order: ['01-a.m4a', '02-b.m4a'],
      pomodoro: {
        enabled: true,
        rounds: 1,
        // SET 1 × 2: STUDY (bip yok) + BREAK; SET 2: STUDY (bip var) + LONG BREAK (bip yok).
        sets: [
          { repeat: 2, steps: [{ name: 'STUDY', minutes: 1, beep: false }, { name: 'BREAK', minutes: 1 }] },
          { steps: [{ name: 'STUDY', minutes: 1 }, { name: 'LONG BREAK', minutes: 1, beep: false }] },
        ],
        cue: { volumeDb: 12 },
      },
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 2 },
      output: { dir: './out' },
      stream: { dir: null },
    }));

    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('timeline dökümü set sırasını ve ad sayaçlarını verir', async () => {
    const text = await readFile(config.output.pomodoroTimeline, 'utf8');
    assert.equal(text.trim(), [
      'GET READY', '00:00 - 02:00', '',
      'STUDY 01', '02:00 - 03:00', '',
      'BREAK 01', '03:00 - 04:00', '',
      'STUDY 02', '04:00 - 05:00', '',
      'BREAK 02', '05:00 - 06:00', '',
      'STUDY 03', '06:00 - 07:00', '',
      'LONG BREAK 01', '07:00 - 08:00',
    ].join('\n'));
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 480) < 0.2, `süre ${out.duration}`);
  });

  test('bipler videodan okunur: yalnızca bipi açık adımların son 3 saniyesinde', async () => {
    const { onsets } = await findOnsets(config.output.video, {
      dir,
      threshold: 10 ** ((report.details['06'].musicPeakDb + 6) / 20),
      minGapSeconds: 0.5,
    });
    const expected = [
      117, 118, 119, // GET READY
      237, 238, 239, // BREAK 01
      357, 358, 359, // BREAK 02
      417, 418, 419, // STUDY 03 (SET 2'de bip açık)
    ];
    assert.equal(onsets.length, expected.length, `bulunan işaretler: ${onsets.map((o) => o.toFixed(2))}`);
    for (const [i, at] of expected.entries()) {
      assert.ok(Math.abs(onsets[i] - at) < 0.2, `bip ${i}: ${onsets[i].toFixed(2)} sn, beklenen ${at} sn`);
    }
    assert.equal(report.pomodoroPlan.cueEvents, 12);
  });
});
