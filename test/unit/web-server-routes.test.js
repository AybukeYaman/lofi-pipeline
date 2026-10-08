/**
 * Rota tablosu ↔ adapter kapsamı.
 *
 * Neden var: `/api/projects/:id/ambient` rotaları eklenip
 * `createDefaultProjectApi()` nesnesine karşılık gelen metotları eklemek
 * atlandığında arayüz yalnızca "Internal server error" gösteriyordu —
 * `api.getAmbient` tanımsız olduğu için. Hiçbir test bunu yakalamıyordu.
 *
 * Bu test her rotanın çağırdığı metot adını kaydedip gerçek adapter'da
 * böyle bir fonksiyon olduğunu doğrular. Yeni bir rota eklenip adapter'a
 * metot eklenmezse burada kırmızı olur, kullanıcıya 500 gitmez.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ROUTES, createDefaultProjectApi } from '../../server/web-server.js';

/** Handler'ların okuduğu bütün parametreler — hangisini kullandığı önemsiz. */
const PARAMS = {
  id: 'proje', body: {}, query: {}, assetType: 'master',
  filename: 'a.png', albumId: '1',
  // Bazı rotalar yakalanan grupları dizi olarak açıyor (assets, music-library).
  params: ['bir', 'iki', 'uc'],
};

describe('rota tablosu — her rota adapter\'da var olan bir metot çağırır', () => {
  const api = createDefaultProjectApi();

  test('rota tablosu boş değil', () => {
    assert.ok(ROUTES.length > 0);
  });

  /**
   * Dosya yükleyen rotalar gövde sınırını SÖYLEMEK zorunda: söylemezse
   * varsayılan 64 KB uygulanıyor ve ilk gerçek ses dosyasında yükleme
   * "Request body too large" ile düşüyor. Ambiance yüklemesi tam böyle
   * kırılmıştı — rota eklendi, `maxBodyBytes` yazılmadı.
   */
  test('yükleme rotalarının gövde sınırı tanımlı ve dosya boyutuna uygun', () => {
    // Shorts rotaları adında "clip" geçse de dosya YÜKLEMİYOR: gövdede
    // yalnızca zaman aralığı/kadraj sayıları var, kaynak video kopyalanmıyor.
    const uploads = ROUTES.filter((route) =>
      route.method === 'POST'
      && /upload|audio|image|clip/.test(route.pattern.source)
      && !/shorts/.test(route.pattern.source));
    assert.ok(uploads.length > 0, 'yükleme rotası bulunamadı');
    for (const route of uploads) {
      assert.equal(
        typeof route.maxBodyBytes, 'number',
        `${route.pattern.source} → maxBodyBytes yazılmamış (64 KB varsayılanına düşer).`,
      );
      // 1 MB'ın altı hiçbir medya dosyasına yetmez; base64 gövdeyi ~%33 şişiriyor.
      assert.ok(
        route.maxBodyBytes >= 1024 * 1024,
        `${route.pattern.source} → gövde sınırı fazla küçük: ${route.maxBodyBytes}`,
      );
    }
  });

  for (const route of ROUTES) {
    const label = `${route.method} ${route.pattern.source}`;
    test(label, async () => {
      // Erişilen her özellik kaydedilir; dönen değer sahte, çağrı gerçekten
      // çalışmıyor — yalnızca HANGİ metodun istendiği öğreniliyor.
      const used = [];
      const probe = new Proxy({}, {
        get(_target, key) {
          used.push(String(key));
          return () => ({});
        },
      });

      await route.handle(probe, PARAMS);

      for (const name of used) {
        assert.equal(
          typeof api[name], 'function',
          `${label} → createDefaultProjectApi() içinde "${name}" yok ` +
          '(rota eklenmiş, adapter metodu eklenmemiş).',
        );
      }
    });
  }
});
