/**
 * test/helpers/regression-compare.js — regresyon testi gerçek bir sapmada DÜŞÜYOR mu?
 *
 * Build yok: ölçüm = baseline.expect'in kopyası (sıfır sapma). Her senaryo baseline
 * kopyasına tek bir sapma enjekte eder ve YALNIZCA beklenen kontrolün düştüğünü doğrular.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { assertAlbumUnchanged, CHECKS, TOLERANCE } from '../helpers/regression-compare.js';

const BASELINE = JSON.parse(readFileSync(new URL('../baseline.json', import.meta.url), 'utf8'));

const CHECK = {
  steps: 'çıktı dosyaları ve adımlar',
  tracks: 'ses: parça süreleri ve damgalar birebir',
  tracklist: 'tracklist metni birebir',
  video: 'video: kırpma, base, montaj planı ve birleşme noktaları',
  file: 'nihai dosya: akışlar, süre, kare, boyut',
  loudness: 'ses seviyesi: tam dosya ve ambient adımı',
  ambient: 'ayrıştırılmış ambient (aynı build\'in montajına karşı)',
  frames: 'görüntü: kare Y/U/V ortalamaları',
};

/** Pristine ölçüm + `mutate(expect)` uygulanmış baseline kopyası → düşen kontrollerin adları ve mesajları. */
function failuresAfter(mutate) {
  const measured = structuredClone(BASELINE.expect);
  const baseline = structuredClone(BASELINE);
  mutate(baseline.expect);
  const failed = {};
  for (const check of CHECKS) {
    try {
      check.run(measured, baseline);
    } catch (err) {
      assert.ok(err instanceof assert.AssertionError, `${check.name}: beklenmeyen hata ${err}`);
      failed[check.name] = err.message;
    }
  }
  return failed;
}

describe('regresyon karşılaştırması', () => {
  test('pozitif kontrol: sapma yoksa tüm kontroller geçer', () => {
    assert.deepEqual(failuresAfter(() => {}), {});
  });

  test('CHECK adları CHECKS ile birebir', () => {
    assert.deepEqual(CHECKS.map((c) => c.name).sort(), Object.values(CHECK).sort());
  });

  // [açıklama, düşmesi beklenen kontrol, mesajda aranan parça, sapma]
  const deviations = [
    ['süre toleransın üstünde', CHECK.file, /süre/, (e) => { e.output.duration += TOLERANCE.durationSeconds * 2; }],
    ['kare sayısı +1', CHECK.file, /frames/, (e) => { e.output.frames += 1; }],
    ['dosya boyutu %3 büyük', CHECK.file, /boyut oranı/, (e) => { e.output.sizeBytes = Math.round(e.output.sizeBytes / 1.03); }],
    ['codec değişti', CHECK.file, /videoCodec/, (e) => { e.output.videoCodec = 'hevc'; }],
    ['tam dosya LUFS', CHECK.loudness, /tam dosya I/, (e) => { e.loudness.integratedLufs -= 0.6; }],
    ['true peak', CHECK.loudness, /true peak/, (e) => { e.loudness.truePeakDb += 0.6; }],
    ['ambient hedefi', CHECK.loudness, /ambient hedefi/, (e) => { e.report.ambientMix.targetI = -30; }],
    ['ambient adımı kayboldu', CHECK.loudness, /ambient adımı var\/yok/, (e) => { e.report.ambientMix = null; }],
    ['ayrıştırılmış ambient', CHECK.ambient, /600\. sn ambient/, (e) => { e.ambientIsolatedLufs['600'] += 0.6; }],
    ['tracklist metninde tek karakter', CHECK.tracklist, /Expected values to be strictly equal/, (e) => {
      e.tracklistText = e.tracklistText.replace('3:19', '3:20');
    }],
    ['YouTube bölüm bayrağı', CHECK.tracklist, /youtubeChapters/, (e) => { e.report.tracklist.youtubeChapters = false; }],
    ['parça damgası 2 ms kaydı', CHECK.tracks, /başlangıcı/, (e) => { e.report.tracks[5].startSeconds += 0.002; }],
    ['parça sırası', CHECK.tracks, /parça 1 dosyası/, (e) => {
      [e.report.tracks[0], e.report.tracks[1]] = [e.report.tracks[1], e.report.tracks[0]];
    }],
    ['parça eksik', CHECK.tracks, /Expected values to be strictly equal/, (e) => { e.report.tracks.pop(); }],
    ['müzik süresi', CHECK.tracks, /müzik süresi/, (e) => { e.report.musicDuration += 0.1; }],
    ['kırpma filtresi', CHECK.video, /crop=/, (e) => { e.report.cropFilter = 'crop=1952:1098:496:10'; }],
    ['montaj planı kopya sayısı', CHECK.video, /copies/, (e) => { e.report.assemble.plan.copies -= 1; }],
    ['birleşme noktası kirli', CHECK.video, /clean/, (e) => { e.report.assemble.junctions[1].clean = false; }],
    ['loop SSIM', CHECK.video, /loop SSIM/, (e) => { e.report.loopSsim -= 0.02; }],
    ['kare parlaklığı', CHECK.frames, /2884\. sn Y/, (e) => { e.frameAverages['2884'].Y += 2; }],
    ['kare rengi', CHECK.frames, /300\. sn V/, (e) => { e.frameAverages['300'].V -= 2; }],
    ['yeni uyarı', CHECK.steps, /beklenmeyen/, (e) => { e.report.warnings.push('beklenmeyen'); }],
    ['adım sırası', CHECK.steps, /'05'/, (e) => { e.report.stepOrder.reverse(); }],
    ['çıktı dosyası farkı', CHECK.steps, /tracklist\.txt/, (e) => { e.outputs.pop(); }],
  ];

  for (const [label, expected, message, mutate] of deviations) {
    test(`sapma yakalanır: ${label}`, () => {
      const failed = failuresAfter(mutate);
      assert.deepEqual(Object.keys(failed), [expected], `yalnızca "${expected}" düşmeli`);
      assert.match(failed[expected], message);
    });
  }

  test('tolerans içindeki sapmalar geçer (aşırı hassas değil)', () => {
    const failed = failuresAfter((e) => {
      e.output.duration += TOLERANCE.durationSeconds / 2;
      e.output.sizeBytes = Math.round(e.output.sizeBytes * 1.01);
      e.loudness.integratedLufs += TOLERANCE.lufs / 2;
      e.report.tracks[3].duration += TOLERANCE.trackSeconds / 2;
      e.frameAverages['300'].Y -= TOLERANCE.frameAverage / 2;
      e.ambientIsolatedLufs['1612'] -= TOLERANCE.ambientLufs / 2;
    });
    assert.deepEqual(failed, {});
  });

  test('ölçüm alanı eksikse (undefined) kontrol düşer, sessizce geçmez', () => {
    const measured = structuredClone(BASELINE.expect);
    delete measured.frameAverages['2884'];
    delete measured.ambientIsolatedLufs['600'];
    delete measured.loudness.rangeLu;
    const run = (name) => () => CHECKS.find((c) => c.name === name).run(measured, BASELINE);
    assert.throws(run(CHECK.frames), TypeError);
    assert.throws(run(CHECK.ambient), /600\. sn ambient: undefined/);
    assert.throws(run(CHECK.loudness), /LRA: undefined/);
  });
});

describe('albüm parmak izi', () => {
  const same = () => structuredClone(BASELINE.album);
  const MESSAGE = /Albüm dosyaları baseline üretildiğinden beri değişmiş/;

  test('aynı albüm: geçer', () => {
    assert.doesNotThrow(() => assertAlbumUnchanged(same(), BASELINE));
  });

  const mismatches = [
    ['ses dosyasının MD5\'i', (f) => { f.audio[4].md5 = '0'.repeat(32); }],
    ['ses dosyası silinmiş', (f) => { f.audio.splice(2, 1); }],
    ['fazla ses dosyası', (f) => { f.audio.push({ name: 'yeni.m4a', md5: 'a'.repeat(32) }); }],
    ['ses dosyası yeniden adlandırılmış', (f) => { f.audio[0].name = '2.m4a'; }],
    ['klip içeriği', (f) => { f.clip.md5 = 'f'.repeat(32); }],
    ['klip yolu', (f) => { f.clip.path = 'videolar/out.mp4'; }],
    ['ambient kaldırılmış', (f) => { f.ambient = null; }],
    ['ambient içeriği', (f) => { f.ambient.md5 = 'e'.repeat(32); }],
  ];

  for (const [label, mutate] of mismatches) {
    test(`uyuşmazlık yakalanır: ${label}`, () => {
      const fingerprint = same();
      mutate(fingerprint);
      assert.throws(() => assertAlbumUnchanged(fingerprint, BASELINE), MESSAGE);
    });
  }
});
