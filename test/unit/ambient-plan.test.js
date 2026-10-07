/**
 * core/ambient-plan.js — `ambient` alanının üç yazım şeklinin tek plana
 * indirgenmesi, seviye ofsetinin özelden genele çözülmesi ve planın geri
 * yazılması.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { layerShareDb } from '../../steps/03-ambient-mix.js';
import {
  AMBIENT_MODES,
  DEFAULT_AMBIENT_MODE,
  DEFAULT_CROSSFADE_SECONDS,
  normalizeAmbientSelection,
  offsetDbFor,
  serializeAmbientPlan,
} from '../../core/ambient-plan.js';

describe('normalizeAmbientSelection — yazım şekilleri', () => {
  test('alan yoksa plan yok, adım atlanır', () => {
    for (const raw of [undefined, null]) {
      const { plan, problems } = normalizeAmbientSelection(raw);
      assert.equal(plan, null);
      assert.deepEqual(problems, []);
    }
  });

  test('tek metin → tek parçalı layer planı', () => {
    const { plan, problems } = normalizeAmbientSelection('./rain.wav');
    assert.deepEqual(problems, []);
    assert.equal(plan.mode, DEFAULT_AMBIENT_MODE);
    assert.equal(plan.crossfade, DEFAULT_CROSSFADE_SECONDS);
    assert.equal(plan.volumeDb, null);
    assert.deepEqual(plan.tracks, [{ path: './rain.wav', volumeDb: null }]);
  });

  test('metin dizisi → sırası korunan çok parçalı plan', () => {
    const { plan, problems } = normalizeAmbientSelection(['rain', 'fire', 'wind']);
    assert.deepEqual(problems, []);
    assert.deepEqual(plan.tracks.map((t) => t.path), ['rain', 'fire', 'wind']);
  });

  test('boş dizi → plan yok (ambient adımı atlanır)', () => {
    assert.equal(normalizeAmbientSelection([]).plan, null);
    assert.equal(normalizeAmbientSelection({ tracks: [] }).plan, null);
  });

  test('nesne şekli: mod, harman, ofset ve parça başına ofset', () => {
    const { plan, problems } = normalizeAmbientSelection({
      mode: 'sequence',
      crossfade: 4,
      volumeDb: -20,
      tracks: ['rain', { path: 'fire', volumeDb: -26 }],
    });
    assert.deepEqual(problems, []);
    assert.equal(plan.mode, 'sequence');
    assert.equal(plan.crossfade, 4);
    assert.equal(plan.volumeDb, -20);
    assert.deepEqual(plan.tracks, [
      { path: 'rain', volumeDb: null },
      { path: 'fire', volumeDb: -26 },
    ]);
  });

  test('harman 0 → dikiş sert, geçerli bir seçim', () => {
    const { plan, problems } = normalizeAmbientSelection({ crossfade: 0, tracks: ['rain'] });
    assert.deepEqual(problems, []);
    assert.equal(plan.crossfade, 0);
  });

  test('her mod kabul edilir', () => {
    for (const mode of AMBIENT_MODES) {
      const { plan, problems } = normalizeAmbientSelection({ mode, tracks: ['rain'] });
      assert.deepEqual(problems, []);
      assert.equal(plan.mode, mode);
    }
  });
});

describe('normalizeAmbientSelection — hatalar tek seferde toplanır', () => {
  test('bilinmeyen mod sorun üretir, varsayılana düşer', () => {
    const { plan, problems } = normalizeAmbientSelection({ mode: 'shuffle', tracks: ['rain'] });
    assert.equal(plan.mode, DEFAULT_AMBIENT_MODE);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ambient\.mode/);
  });

  test('aralık dışı ofset ve harman', () => {
    const { problems } = normalizeAmbientSelection({
      volumeDb: 5, crossfade: 99, tracks: [{ path: 'rain', volumeDb: -200 }],
    });
    assert.equal(problems.length, 3);
    assert.ok(problems.some((p) => /ambient\.volumeDb/.test(p)));
    assert.ok(problems.some((p) => /ambient\.crossfade/.test(p)));
    assert.ok(problems.some((p) => /ambient\[0\]\.volumeDb/.test(p)));
  });

  test('yazım hatası sessizce yok sayılmaz', () => {
    const { problems } = normalizeAmbientSelection({ tracs: ['rain'], tracks: ['rain'] });
    assert.ok(problems.some((p) => /ambient\.tracs/.test(p)));
  });

  test('nesne şeklinde tracks zorunlu', () => {
    const { plan, problems } = normalizeAmbientSelection({ mode: 'layer' });
    assert.equal(plan, null);
    assert.match(problems[0], /ambient\.tracks/);
  });

  test('boş ve hatalı parçalar ayrı ayrı bildirilir', () => {
    const { plan, problems } = normalizeAmbientSelection(['rain', '   ', 42]);
    assert.deepEqual(plan.tracks.map((t) => t.path), ['rain']);
    assert.equal(problems.length, 2);
  });

  test('aynı dosya iki kez verilirse ikincisi atılır', () => {
    const { plan, problems } = normalizeAmbientSelection(['rain', 'RAIN']);
    assert.deepEqual(plan.tracks.map((t) => t.path), ['rain']);
    assert.match(problems[0], /iki kez/);
  });

  test('tanınmayan tür', () => {
    const { plan, problems } = normalizeAmbientSelection(42);
    assert.equal(plan, null);
    assert.equal(problems.length, 1);
  });
});

describe('offsetDbFor — özelden genele', () => {
  const config = -18.8;

  test('parça ofseti plandan ve configden önce gelir', () => {
    const plan = { volumeDb: -20, tracks: [] };
    assert.equal(offsetDbFor({ path: 'a', volumeDb: -30 }, plan, config), -30);
  });

  test('parça ofseti yoksa plan ofseti', () => {
    const plan = { volumeDb: -20, tracks: [] };
    assert.equal(offsetDbFor({ path: 'a', volumeDb: null }, plan, config), -20);
  });

  test('ikisi de yoksa audio.ambientOffsetDb', () => {
    const plan = { volumeDb: null, tracks: [] };
    assert.equal(offsetDbFor({ path: 'a', volumeDb: null }, plan, config), config);
  });
});

describe('serializeAmbientPlan — varsayılandan sapmayan alan yazılmaz', () => {
  /** @param {unknown} raw */
  const roundTrip = (raw) => serializeAmbientPlan(normalizeAmbientSelection(raw).plan);

  test('plan yoksa alan hiç yazılmaz', () => {
    assert.equal(serializeAmbientPlan(null), undefined);
  });

  test('tek parça + varsayılanlar → düz metin kalır', () => {
    assert.equal(roundTrip('rain'), 'rain');
  });

  test('çok parça + varsayılanlar → düz dizi kalır', () => {
    assert.deepEqual(roundTrip(['rain', 'fire']), ['rain', 'fire']);
  });

  test('varsayılandan sapan ayar nesneye geçirir', () => {
    assert.deepEqual(roundTrip({ mode: 'sequence', tracks: ['rain', 'fire'] }), {
      mode: 'sequence', tracks: ['rain', 'fire'],
    });
    assert.deepEqual(roundTrip({ crossfade: 6, tracks: ['rain'] }), {
      crossfade: 6, tracks: ['rain'],
    });
  });

  test('parça ofseti korunur, ofsetsiz parça metin kalır', () => {
    assert.deepEqual(roundTrip({ tracks: [{ path: 'rain', volumeDb: -26 }, 'fire'] }), {
      tracks: [{ path: 'rain', volumeDb: -26 }, 'fire'],
    });
  });

  test('yeniden okunduğunda aynı plan çıkar', () => {
    const raw = { mode: 'sequence', crossfade: 3, volumeDb: -21, tracks: [{ path: 'rain', volumeDb: -26 }, 'fire'] };
    const once = normalizeAmbientSelection(raw).plan;
    const twice = normalizeAmbientSelection(serializeAmbientPlan(once)).plan;
    assert.deepEqual(twice, once);
  });
});

describe('layerShareDb — üst üste binen seslerin toplamı ofseti aşmaz', () => {
  /** @param {string[]} paths @param {object} extra */
  const planOf = (paths, extra = {}) =>
    normalizeAmbientSelection({ ...extra, tracks: paths }).plan;

  test('tek ses bölüşmez', () => {
    assert.equal(layerShareDb(planOf(['a'])), 0);
  });

  test('iki ses: her birine -3.01 dB (toplamı tek sese eşitler)', () => {
    assert.equal(layerShareDb(planOf(['a', 'b'])), -3.01);
  });

  test('dört ses: -6.02 dB', () => {
    assert.equal(layerShareDb(planOf(['a', 'b', 'c', 'd'])), -6.02);
  });

  test('sequence modunda bölüşme yok — aynı anda tek ses çalıyor', () => {
    assert.equal(layerShareDb(planOf(['a', 'b', 'c'], { mode: 'sequence' })), 0);
  });

  test('kendi seviyesi verilmiş parça bölüşmeye girmez', () => {
    // Biri açıkça -30 demiş: kalan tek parça bölüşecek kimse bulamaz.
    const plan = normalizeAmbientSelection({
      tracks: [{ path: 'a', volumeDb: -30 }, 'b'],
    }).plan;
    assert.equal(layerShareDb(plan), 0);
  });

  test('pay güç toplamını ofsete geri getirir', () => {
    // N eşit kaynak +10·log10(N) yükseltir; pay tam onu geri alır.
    for (const n of [2, 3, 4, 7]) {
      const plan = planOf(Array.from({ length: n }, (_, i) => `t${i}`));
      const share = layerShareDb(plan);
      const combined = 10 * Math.log10(n * 10 ** (share / 10));
      assert.ok(Math.abs(combined) < 0.05, `${n} ses → ${combined}`);
    }
  });
});
