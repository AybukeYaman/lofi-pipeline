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
        workMinutes: 1,
        breakMinutes: 1,
        rounds: 2,
        // Kırpma onaylı: fazla 40 sn sorulmadan kesilsin (onay akışı
        // test/unit/web-pomodoro.test.js'te ayrıca doğrulanıyor).
        trimExcess: true,
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

  test('timeline dosyası GET READY + WORK/BREAK dökümünü verir', async () => {
    const text = await readFile(config.output.pomodoroTimeline, 'utf8');
    assert.equal(text.trim(), [
      'GET READY', '00:00 - 02:00', '',
      'WORK 01', '02:00 - 03:00', '',
      'BREAK 01', '03:00 - 04:00', '',
      'WORK 02', '04:00 - 05:00', '',
      'BREAK 02', '05:00 - 06:00',
    ].join('\n'));
  });

  test('Test 5 — her oturumun son 3 saniyesinde 3 bip: GET READY, çalışma, mola ve videonun sonu', async () => {
    const { onsets } = await findOnsets(config.output.video, { dir, ...onsetOptions() });

    // 5 oturum (GET READY 0-120, WORK 120-180, BREAK 180-240, WORK 240-300, BREAK 300-360).
    // Başlangıç sesi YOK: yalnızca her oturumun bitişinden önceki 3 bip.
    const expected = [
      117, 118, 119,   // GET READY'nin 2. dakikasının son 3 sn'si
      177, 178, 179,   // WORK 01
      237, 238, 239,   // BREAK 01
      297, 298, 299,   // WORK 02
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
      'GET READY', 'WORK 01', 'BREAK 01', 'WORK 02', 'BREAK 02',
    ]);
    // 5 oturum × 3 bip
    assert.equal(report.pomodoroPlan.cueEvents, 15);
  });
});
