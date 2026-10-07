/**
 * Uçtan uca build, Pomodoro açık: doğrulama → fazla müziğin kırpılması →
 * işaret seslerinin timeline'a bindirilmesi → montaj. Gerçek encode.
 *
 * Spec'teki Test 2 (fazla müzik kırpılır) ve Test 5 (oturum geçişlerinde
 * 3 saniyelik geri sayım + başlangıç efekti) burada ölçülerek doğrulanıyor:
 * işaretler nihai videodan geri okunuyor, filtre metnine bakılarak değil.
 *
 * Süreler dakika cinsinden olmak zorunda (Pomodoro'nun birimi bu), o yüzden
 * en küçük anlamlı kurulum seçildi: 1/1 × 2 tur = 4 dakika.
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

    // 3 × 100 sn = 300 sn müzik, 240 sn timeline → 60 sn fazla.
    await makeQuietTone(dir.path('audio/01-a.m4a'), { seconds: 100, frequency: 220 });
    await makeQuietTone(dir.path('audio/02-b.m4a'), { seconds: 100, frequency: 330 });
    await makeQuietTone(dir.path('audio/03-c.m4a'), { seconds: 100, frequency: 440 });

    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      order: ['01-a.m4a', '02-b.m4a', '03-c.m4a'],
      pomodoro: {
        enabled: true,
        workMinutes: 1,
        breakMinutes: 1,
        rounds: 2,
        // Kırpma onaylı: fazla 60 sn sorulmadan kesilsin (onay akışı
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

  test('çıktı Pomodoro timeline süresinde (240 sn), müzik süresinde değil', async () => {
    const out = await probe(config.output.video);
    assert.ok(Math.abs(out.duration - 240) < 0.2, `süre ${out.duration}`);
  });

  test('adım sırası: ses → işaretler → montaj (Ambiance yok, 03 atlandı)', () => {
    assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '06', '04', '05']);
  });

  test('Test 2 — fazla 60 sn son parçadan kırpıldı, orijinal dosya değişmedi', async () => {
    const { trim, comparison } = report.pomodoroPlan;
    assert.equal(comparison.status, 'excess');
    assert.equal(Math.round(comparison.excessSeconds), 60);
    assert.equal(trim.trimmedCount, 1);
    assert.equal(trim.droppedCount, 0);
    assert.deepEqual(trim.tracks.map((t) => Math.round(t.usedDuration)), [100, 100, 40]);

    // Kırpma yalnızca render'da: kaynak dosya hâlâ 100 saniye.
    const source = await probe(dir.path('audio/03-c.m4a'));
    assert.ok(Math.abs(source.duration - 100) < 0.2, `kaynak ${source.duration}`);
  });

  test('tracklist kırpılmış süreye göre damgalanır', async () => {
    const text = await readFile(config.output.tracklist, 'utf8');
    assert.deepEqual(text.trim().split('\n').map((line) => line.split('  ')[0]), ['0:00', '1:40', '3:20']);
  });

  test('timeline dosyası WORK/BREAK dökümünü verir', async () => {
    const text = await readFile(config.output.pomodoroTimeline, 'utf8');
    assert.equal(text.trim(), [
      'WORK 01', '00:00 - 01:00', '',
      'BREAK 01', '01:00 - 02:00', '',
      'WORK 02', '02:00 - 03:00', '',
      'BREAK 02', '03:00 - 04:00',
    ].join('\n'));
  });

  test('Test 5 — her geçişte 3 beep + başlangıç efekti, doğru saniyelerde', async () => {
    const { onsets } = await findOnsets(config.output.video, { dir, ...onsetOptions() });

    // 4 oturum var; ilkinin geri sayımı videodan önceye düştüğü için atlanıyor.
    //   t=0   WORK 01 başlangıç efekti
    //   57,58,59,60    BREAK 01
    //   117,118,119,120 WORK 02
    //   177,178,179,180 BREAK 02
    const expected = [0, 57, 58, 59, 60, 117, 118, 119, 120, 177, 178, 179, 180];
    assert.equal(onsets.length, expected.length, `bulunan işaretler: ${onsets.map((o) => o.toFixed(2))}`);
    for (const [i, at] of expected.entries()) {
      assert.ok(
        Math.abs(onsets[i] - at) < 0.2,
        `işaret ${i}: ${onsets[i].toFixed(2)} sn, beklenen ${at} sn`,
      );
    }
  });

  test('geri sayımın son beep\'i ile oturum başlangıcı arasında tam 1 saniye var', async () => {
    const { onsets } = await findOnsets(config.output.video, { dir, ...onsetOptions() });
    // 60, 120, 180 başlangıçları: bir öncekiyle farkı 1 sn olmalı.
    for (const start of [60, 120, 180]) {
      const i = onsets.findIndex((o) => Math.abs(o - start) < 0.2);
      assert.ok(Math.abs((onsets[i] - onsets[i - 1]) - 1) < 0.05, `${start}. sn geçişi`);
    }
  });

  test('raporda plan, oturumlar ve işaret sayısı var', () => {
    assert.equal(report.pomodoro, 'applied');
    assert.equal(report.pomodoroPlan.rounds, 2);
    assert.equal(report.pomodoroPlan.totalSeconds, 240);
    assert.deepEqual(report.pomodoroPlan.sessions.map((s) => s.label), [
      'WORK 01', 'BREAK 01', 'WORK 02', 'BREAK 02',
    ]);
    // 4 oturum × (3 beep + 1 efekt) − ilk oturumun atlanan 3 beep'i = 13
    assert.equal(report.pomodoroPlan.cueEvents, 13);
    assert.equal(report.details['06'].skippedCount, 3);
  });
});
