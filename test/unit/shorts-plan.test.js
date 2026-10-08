import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildShortsFilter,
  clipOutputName,
  computeShortsCrop,
  formatTimecode,
  MAX_SHORTS_SECONDS,
  nextClipId,
  nextClipTitle,
  normalizeShortsClip,
  normalizeShortsPlan,
  serializeShortsPlan,
  SHORTS_TARGET,
} from '../../core/shorts-plan.js';

describe('computeShortsCrop — 9:16 kadraj', () => {
  test('yatay kaynakta tüm yükseklik kullanılır, kutu ortalanır', () => {
    const crop = computeShortsCrop({ sourceWidth: 1920, sourceHeight: 1080 });
    assert.equal(crop.height, 1080);
    // 1080 * 9/16 = 607.5 → çift sayıya aşağı yuvarlanır
    assert.equal(crop.width, 606);
    // (1920-606)/2 = 657 → ofset de çift sayıya iniyor
    assert.equal(crop.x, 656);
    assert.equal(crop.y, 0);
  });

  test('dikey kaynakta tüm genişlik kullanılır', () => {
    const crop = computeShortsCrop({ sourceWidth: 720, sourceHeight: 1600 });
    assert.equal(crop.width, 720);
    assert.equal(crop.height, 1280); // 720 / (9/16)
    assert.equal(crop.x, 0);
  });

  test('zoom kutuyu küçültür, x/y kutuyu kaydırır', () => {
    const crop = computeShortsCrop({ sourceWidth: 1920, sourceHeight: 1080, zoom: 2, x: 0, y: 1 });
    assert.equal(crop.height, 540);
    assert.equal(crop.width, 302); // 303 → çift
    assert.equal(crop.x, 0);
    assert.equal(crop.y, 1080 - 540);
  });

  test('en ve boy her zaman çift (libx264 yuv420p şartı)', () => {
    for (const zoom of [1, 1.3, 1.7, 2.4, 3.9]) {
      const crop = computeShortsCrop({ sourceWidth: 1281, sourceHeight: 721, zoom });
      assert.equal(crop.width % 2, 0, `genişlik tek: ${crop.width}`);
      assert.equal(crop.height % 2, 0, `yükseklik tek: ${crop.height}`);
      assert.equal(crop.x % 2, 0);
      assert.equal(crop.y % 2, 0);
      assert.ok(crop.x + crop.width <= 1281);
      assert.ok(crop.y + crop.height <= 721);
    }
  });

  test('zoom ve konum sınırların dışına taşmaz', () => {
    const tooFar = computeShortsCrop({ sourceWidth: 1920, sourceHeight: 1080, zoom: 99, x: 5, y: -3 });
    const maxZoom = computeShortsCrop({ sourceWidth: 1920, sourceHeight: 1080, zoom: 4, x: 1, y: 0 });
    assert.deepEqual(tooFar, { ...maxZoom, y: 0 });
  });

  test('ölçüsüz kaynak hata verir', () => {
    assert.throws(() => computeShortsCrop({ sourceWidth: 0, sourceHeight: 0 }), /ölçüsü okunamadı/);
  });

  test('filtre kırpma + hedef ölçek üretir', () => {
    const filter = buildShortsFilter({ width: 606, height: 1080, x: 657, y: 0 });
    assert.equal(
      filter,
      `crop=606:1080:657:0,scale=${SHORTS_TARGET.width}:${SHORTS_TARGET.height}:flags=lanczos,setsar=1`,
    );
  });
});

describe('normalizeShortsClip', () => {
  const base = { id: 'kesit-01', title: 'Shorts 01', start: 10, end: 47 };

  test('geçerli kesit süresini hesaplar, kadraj varsayılanı ortada', () => {
    const { clip, problems } = normalizeShortsClip(base);
    assert.deepEqual(problems, []);
    assert.equal(clip.duration, 37);
    assert.deepEqual(clip.frame, { zoom: 1, x: 0.5, y: 0.5 });
    assert.equal(clip.output, 'shorts-01.mp4');
  });

  test('ters/çok kısa aralık reddedilir', () => {
    assert.equal(normalizeShortsClip({ ...base, end: 9 }).clip, null);
    assert.match(normalizeShortsClip({ ...base, end: 10.4 }).problems[0], /en az 1 sn/);
  });

  test('kaynaktan uzun bitiş reddedilir', () => {
    const { clip, problems } = normalizeShortsClip(base, { sourceDuration: 20 });
    assert.equal(clip, null);
    assert.match(problems[0], /kaynak videodan uzun/);
  });

  test('Shorts sınırını aşan süre uyarı, hata değil', () => {
    const { clip, warnings } = normalizeShortsClip({ ...base, end: 10 + MAX_SHORTS_SECONDS + 5 });
    assert.ok(clip);
    assert.match(warnings[0], /Shorts sınırı/);
  });

  test('kadraj değerleri sınırlara çekilir', () => {
    const { clip } = normalizeShortsClip({ ...base, frame: { zoom: 99, x: -1, y: 4 } });
    assert.deepEqual(clip.frame, { zoom: 4, x: 0, y: 1 });
  });
});

describe('normalizeShortsPlan', () => {
  test('kesitler zaman sırasına dizilir, bozuk kayıt problem olarak bildirilir', () => {
    const plan = normalizeShortsPlan({
      source: '../Ana/out/final.mp4',
      clips: [
        { id: 'b', title: 'İkinci', start: 60, end: 75 },
        { id: 'a', title: 'Birinci', start: 5, end: 20 },
        { id: 'c', title: 'Bozuk', start: 30, end: 10 },
      ],
    });
    assert.equal(plan.source, '../Ana/out/final.mp4');
    assert.deepEqual(plan.clips.map((clip) => clip.id), ['a', 'b']);
    assert.equal(plan.problems.length, 1);
  });

  test('aynı kimlik iki kez kullanılamaz', () => {
    const plan = normalizeShortsPlan({
      clips: [
        { id: 'a', start: 0, end: 5 },
        { id: 'a', start: 10, end: 15 },
      ],
    });
    assert.equal(plan.clips.length, 1);
    assert.match(plan.problems[0], /aynı kimlik/);
  });

  test('blok yoksa boş plan, yanlış türde problem', () => {
    assert.deepEqual(normalizeShortsPlan(undefined), { source: null, clips: [], problems: [], warnings: [] });
    assert.deepEqual(normalizeShortsPlan([]).problems, ['shorts bir nesne olmalı']);
  });

  test('serialize varsayılan kadrajı yazmaz, değişeni yazar', () => {
    const plan = normalizeShortsPlan({
      source: 'x.mp4',
      clips: [
        { id: 'a', title: 'A', start: 1, end: 3 },
        { id: 'b', title: 'B', start: 5, end: 9, frame: { zoom: 1.5, x: 0.2, y: 0.5 }, renderedAt: '2026-10-07T00:00:00.000Z' },
      ],
    });
    const json = serializeShortsPlan(plan);
    assert.equal(json.clips[0].frame, undefined);
    assert.deepEqual(json.clips[1].frame, { zoom: 1.5, x: 0.2, y: 0.5 });
    assert.equal(json.clips[1].renderedAt, '2026-10-07T00:00:00.000Z');
    // Gidip gelmek planı değiştirmiyor (yazım kaybı yok).
    assert.deepEqual(normalizeShortsPlan(json).clips, plan.clips);
  });
});

describe('kimlik, ad ve damga yardımcıları', () => {
  test('nextClipId / nextClipTitle kullanılmayanı verir', () => {
    const clips = [{ id: 'kesit-01', title: 'Shorts 01' }, { id: 'kesit-02', title: 'Shorts 02' }];
    assert.equal(nextClipId(clips), 'kesit-03');
    assert.equal(nextClipTitle(clips), 'Shorts 03');
  });

  test('çıktı adı Türkçe karakterleri ve boşlukları temizler', () => {
    assert.equal(clipOutputName('kesit-01', 'Çocuk Şenliği — Giriş'), 'cocuk-senligi-giris.mp4');
    assert.equal(clipOutputName('kesit-07', '***'), 'kesit-07.mp4');
  });

  test('formatTimecode dakika:saniye.ondalık', () => {
    assert.equal(formatTimecode(0), '00:00.0');
    assert.equal(formatTimecode(37.25), '00:37.3');
    assert.equal(formatTimecode(261), '04:21.0');
    assert.equal(formatTimecode(3723.5), '1:02:03.5');
  });
});
