/**
 * Ortak Ambiance klasörü uçları: yükleme, listeleme, silme.
 *
 * Neden var: "Ambiance sayfasından ses ekledim ama Müzik adımında
 * görünmüyor" hatası, ekleme formunun dosyayı diske HİÇ yazmamasından
 * geliyordu (yalnızca ekrana satır ekliyordu). Buradaki testler dosyanın
 * gerçekten klasöre düştüğünü ve seçicinin onu gördüğünü doğrular.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ApiError, deleteAmbient, getAmbientAsset, getLibrary, uploadAmbient } from '../../server/project-api.js';

/** Base64 gövde — içerik önemsiz, dosyanın yazıldığı doğrulanıyor. */
const DATA = Buffer.from('fake-audio-bytes').toString('base64');

describe('Ambiance kütüphanesi uçları', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'lofi-ambient-')); });
  after(() => rm(dir, { recursive: true, force: true }));

  test('yükleme dosyayı klasöre yazar ve listede döner', async () => {
    const res = await uploadAmbient({ name: 'softRain.mp3', data: DATA }, { ambientDir: dir });
    assert.deepEqual(res.ambients.map((a) => a.name), ['softRain']);
    // Asıl iddia: dosya gerçekten diskte.
    assert.equal(await readFile(join(dir, 'softRain.mp3'), 'utf8'), 'fake-audio-bytes');
  });

  test('listeleme diskten okur', async () => {
    const res = await getLibrary({ ambientDir: dir });
    assert.ok(res.ambients.some((a) => a.name === 'softRain'));
  });

  test('aynı ad 409 — başka projelerin kullandığı ses sessizce ezilmez', async () => {
    await assert.rejects(
      uploadAmbient({ name: 'softRain.mp3', data: DATA }, { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 409,
    );
  });

  test('desteklenmeyen uzantı reddedilir', async () => {
    await assert.rejects(
      uploadAmbient({ name: 'kotu.exe', data: DATA }, { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('ad zorunlu', async () => {
    await assert.rejects(
      uploadAmbient({ data: DATA }, { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('yol kaçışı denemesi reddedilir', async () => {
    await assert.rejects(
      uploadAmbient({ name: '../kacti.mp3', data: DATA }, { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('dinleme ucu dosyayı, boyutunu ve MIME türünü verir', async () => {
    const asset = await getAmbientAsset('softRain', { ambientDir: dir });
    assert.equal(asset.contentType, 'audio/mpeg');
    assert.equal(asset.size, 'fake-audio-bytes'.length);
    assert.ok(asset.path.endsWith('softRain.mp3'));
  });

  test('dinleme: uzantılı ad da kabul edilir', async () => {
    const asset = await getAmbientAsset('softRain.mp3', { ambientDir: dir });
    assert.ok(asset.path.endsWith('softRain.mp3'));
  });

  test('dinleme: bilinmeyen ses 404', async () => {
    await assert.rejects(
      getAmbientAsset('olmayanSes', { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 404,
    );
  });

  test('dinleme: yol kaçışı klasör dışına çıkamaz', async () => {
    // Ad listeden çözüldüğü için istekteki metin hiç dosya yoluna çevrilmiyor.
    for (const name of ['../gizli', '..\gizli', '/etc/passwd']) {
      await assert.rejects(
        getAmbientAsset(name, { ambientDir: dir }),
        (error) => error instanceof ApiError && error.status === 404,
        `"${name}" reddedilmeliydi`,
      );
    }
  });

  test('bilinmeyen ses silinmek istenirse 404', async () => {
    await assert.rejects(
      deleteAmbient('olmayanSes', { ambientDir: dir }),
      (error) => error instanceof ApiError && error.status === 404,
    );
  });

  test('uzantısız kısa ad da uzantılı ad da silmek için kabul edilir', async () => {
    // Silme Geri Dönüşüm Kutusu'na gidiyor (PowerShell) — testte kabuğa
    // çıkmamak için yalnızca ADIN ÇÖZÜLDÜĞÜ doğrulanıyor: bulunamayan ses
    // 404 veriyordu, bulunan ses artık o hatayı vermiyor.
    await writeFile(join(dir, 'kisa.wav'), 'x');
    for (const name of ['kisa', 'kisa.wav']) {
      const error = await deleteAmbient(name, { ambientDir: dir }).then(() => null, (e) => e);
      assert.ok(
        error === null || !(error instanceof ApiError && error.status === 404),
        `"${name}" çözülemedi: ${error?.message}`,
      );
      await writeFile(join(dir, 'kisa.wav'), 'x');
    }
  });
});
