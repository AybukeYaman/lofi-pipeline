/**
 * test/regression.js'in karşılaştırma mantığı — ölçüm/build'den bağımsız, saf fonksiyonlar.
 *
 * Ayrı modülde çünkü regresyon testinin gerçek bir sapmada DÜŞTÜĞÜ, 9 dk'lık build
 * olmadan sahte ölçüm objeleriyle sınanabilmeli (test/unit/regression-compare.test.js).
 *
 * `measured` şekli: baseline.expect ile aynı alanlar (outputs, report, tracklistText, output,
 * loudness, ambientIsolatedLufs, frameAverages); fazlası yok sayılır.
 */

import assert from 'node:assert/strict';

import { DURATION_TOLERANCE } from '../../core/probe.js';

export const TOLERANCE = {
  durationSeconds: DURATION_TOLERANCE,
  trackSeconds: 0.001,
  sizeRatio: 0.02,
  lufs: 0.5,
  truePeakDb: 0.5,
  ambientLufs: 0.5,
  frameAverage: 1.5,
  loopSsim: 0.01,
};

const near = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, baseline ${expected} (tolerans ±${tolerance})`,
  );
};

/** Albüm değiştiyse karşılaştırma anlamsız — build'den önce açık mesajla dur. */
export function assertAlbumUnchanged(fingerprint, baseline) {
  assert.deepEqual(
    fingerprint, baseline.album,
    'Albüm dosyaları baseline üretildiğinden beri değişmiş — karşılaştırma anlamsız. ' +
    'Bilerek değiştirdiysen --update ile yeniden üret.',
  );
}

/** Sıralı karşılaştırmalar; her biri regression.js'te ayrı bir test olur. */
export const CHECKS = [
  {
    name: 'çıktı dosyaları ve adımlar',
    run(measured, baseline) {
      const e = baseline.expect;
      assert.deepEqual(measured.outputs, e.outputs);
      assert.deepEqual(measured.report.stepOrder, e.report.stepOrder);
      assert.deepEqual(measured.report.warnings, e.report.warnings);
      assert.equal(measured.report.sortSource, e.report.sortSource);
      assert.equal(measured.report.ambient, e.report.ambient);
    },
  },
  {
    name: 'ses: parça süreleri ve damgalar birebir',
    run(measured, baseline) {
      const e = baseline.expect.report;
      assert.equal(measured.report.tracks.length, e.tracks.length);
      measured.report.tracks.forEach((t, i) => {
        assert.equal(t.file, e.tracks[i].file, `parça ${i + 1} dosyası`);
        near(t.duration, e.tracks[i].duration, TOLERANCE.trackSeconds, `${t.file} süresi`);
        near(t.startSeconds, e.tracks[i].startSeconds, TOLERANCE.trackSeconds, `${t.file} başlangıcı`);
      });
      near(measured.report.musicDuration, e.musicDuration, TOLERANCE.durationSeconds, 'müzik süresi');
    },
  },
  {
    name: 'tracklist metni birebir',
    run(measured, baseline) {
      assert.equal(measured.tracklistText, baseline.expect.tracklistText);
      assert.deepEqual(measured.report.tracklist, baseline.expect.report.tracklist);
    },
  },
  {
    name: 'video: kırpma, base, montaj planı ve birleşme noktaları',
    run(measured, baseline) {
      const e = baseline.expect.report;
      assert.equal(measured.report.cropFilter, e.cropFilter);
      assert.deepEqual(measured.report.base, e.base);
      near(measured.report.loopSsim, e.loopSsim, TOLERANCE.loopSsim, 'loop SSIM');
      assert.deepEqual(measured.report.assemble, e.assemble);
    },
  },
  {
    name: 'nihai dosya: akışlar, süre, kare, boyut',
    run(measured, baseline) {
      const o = measured.output;
      const e = baseline.expect.output;
      for (const key of ['width', 'height', 'fps', 'videoCodec', 'audioCodec', 'sampleRate', 'channels', 'frames']) {
        assert.equal(o[key], e[key], key);
      }
      near(o.duration, e.duration, TOLERANCE.durationSeconds, 'süre');
      near(o.sizeBytes / e.sizeBytes, 1, TOLERANCE.sizeRatio, 'boyut oranı');
    },
  },
  {
    name: 'ses seviyesi: tam dosya ve ambient adımı',
    run(measured, baseline) {
      const l = measured.loudness;
      const e = baseline.expect.loudness;
      near(l.integratedLufs, e.integratedLufs, TOLERANCE.lufs, 'tam dosya I (LUFS)');
      near(l.rangeLu, e.rangeLu, TOLERANCE.lufs, 'LRA');
      near(l.truePeakDb, e.truePeakDb, TOLERANCE.truePeakDb, 'true peak');

      const m = measured.report.ambientMix;
      const em = baseline.expect.report.ambientMix;
      assert.equal(m === null, em === null, 'ambient adımı var/yok');
      if (m) {
        near(m.musicI, em.musicI, TOLERANCE.lufs, 'müzik I');
        assert.equal(m.targetI, em.targetI, 'ambient hedefi');
        near(m.verificationAmbientI, em.verificationAmbientI, TOLERANCE.lufs, '03 doğrulama ambient');
        near(m.verificationMixI, em.verificationMixI, TOLERANCE.lufs, '03 doğrulama karışım');
      }
    },
  },
  {
    name: 'ayrıştırılmış ambient (aynı build\'in montajına karşı)',
    run(measured, baseline) {
      for (const [t, expected] of Object.entries(baseline.expect.ambientIsolatedLufs)) {
        near(measured.ambientIsolatedLufs[t], expected, TOLERANCE.ambientLufs, `${t}. sn ambient`);
      }
    },
  },
  {
    name: 'görüntü: kare Y/U/V ortalamaları',
    run(measured, baseline) {
      for (const [t, expected] of Object.entries(baseline.expect.frameAverages)) {
        for (const channel of ['Y', 'U', 'V']) {
          near(measured.frameAverages[t][channel], expected[channel], TOLERANCE.frameAverage, `${t}. sn ${channel}`);
        }
      }
    },
  },
];
