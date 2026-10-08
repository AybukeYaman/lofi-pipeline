import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  convertMimiImageToLoop,
  deleteMimiAsset,
  getMimiAsset,
  getMimiGallery,
  openMimiFolder,
  uploadMimiAsset,
} from '../../server/mimi-api.js';

/** Boş bir Mimi klasörü — her test kendi geçici klasöründe çalışır. */
async function createMimiDir() {
  return mkdtemp(join(tmpdir(), 'lofi-mimi-'));
}

const PNG_BASE64 = Buffer.from('fake-png-bytes').toString('base64');

describe('mimi galerisi', () => {
  test('klasör yoksa oluşturur ve boş galeri döner', async () => {
    const base = await createMimiDir();
    const mimiDir = join(base, 'mimi-galeri');
    try {
      const gallery = await getMimiGallery({ mimiDir });
      assert.equal(gallery.error, null);
      assert.deepEqual(gallery.items, []);
      assert.ok((await stat(mimiDir)).isDirectory());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('resim ve videoyu listeler, desteklenmeyen uzantıyı atlar', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi-kedi.png'), 'img');
      await writeFile(join(mimiDir, 'mimi-dans.mp4'), 'vid');
      await writeFile(join(mimiDir, 'notlar.txt'), 'yok');

      const { items } = await getMimiGallery({ mimiDir });
      assert.equal(items.length, 2);
      const byFile = Object.fromEntries(items.map((item) => [item.file, item]));
      assert.equal(byFile['mimi-kedi.png'].kind, 'image');
      assert.equal(byFile['mimi-kedi.png'].name, 'mimi-kedi');
      assert.equal(byFile['mimi-dans.mp4'].kind, 'video');
      assert.equal(byFile['mimi-dans.mp4'].previewUrl, '/api/mimi/assets/mimi-dans.mp4');
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('yükleme dosyayı yazar, ad çakışırsa benzersizleştirir', async () => {
    const mimiDir = await createMimiDir();
    try {
      const first = await uploadMimiAsset({ name: 'mimi.png', data: PNG_BASE64 }, { mimiDir });
      assert.equal(first.file, 'mimi.png');
      assert.equal(await readFile(join(mimiDir, 'mimi.png'), 'utf8'), 'fake-png-bytes');

      const second = await uploadMimiAsset({ name: 'mimi.png', data: `data:image/png;base64,${PNG_BASE64}` }, { mimiDir });
      assert.equal(second.file, 'mimi (1).png');
      assert.equal(second.items.length, 2);
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('desteklenmeyen uzantı, bozuk ad ve boş veri reddedilir', async () => {
    const mimiDir = await createMimiDir();
    try {
      await assert.rejects(
        () => uploadMimiAsset({ name: 'mimi.txt', data: PNG_BASE64 }, { mimiDir }),
        /Unsupported format/,
      );
      await assert.rejects(
        () => uploadMimiAsset({ name: '..\\kacis.png', data: PNG_BASE64 }, { mimiDir }),
        /Invalid file name/,
      );
      await assert.rejects(
        () => uploadMimiAsset({ name: 'mimi.png', data: '' }, { mimiDir }),
        /File data is empty/,
      );
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('asset doğru MIME ile akıtılır; klasör dışı yol 404', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi.webm'), 'vid');
      const asset = await getMimiAsset('mimi.webm', { mimiDir });
      assert.equal(asset.contentType, 'video/webm');
      assert.equal(asset.size, 3);

      await assert.rejects(() => getMimiAsset('yok.png', { mimiDir }), /Asset not found/);
      await assert.rejects(() => getMimiAsset('../gizli.png', { mimiDir }), /Invalid file name/);
      await assert.rejects(() => getMimiAsset('mimi.txt', { mimiDir }), /Unsupported asset format/);
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('silme Geri Dönüşüm Kutusu\'na taşır ve güncel galeriyi döner', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi.png'), 'img');
      const trashed = [];
      // Gerçek silme Windows'a bağlı (core/trash.js) — burada yalnızca
      // doğru yolun çağrıldığı doğrulanıyor.
      const gallery = await deleteMimiAsset('mimi.png', {
        mimiDir,
        trashFn: async (path) => { trashed.push(path); await rm(path, { force: true }); },
      });
      assert.equal(trashed.length, 1);
      assert.match(trashed[0], /mimi\.png$/);
      assert.deepEqual(gallery.items, []);

      await assert.rejects(() => deleteMimiAsset('mimi.png', { mimiDir }), /File not found/);
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('resim → loop video: ffmpeg sabit kare argümanlarıyla çağrılır', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi-kedi.png'), 'img');
      const calls = [];
      // ffmpeg adapter'ı sahte: encode yerine çıktı dosyasını yazıyoruz.
      const ffmpegFn = async (args) => {
        calls.push(args);
        await writeFile(args[args.length - 1], 'loop');
        return { code: 0, stdout: '', stderr: '' };
      };

      const res = await convertMimiImageToLoop(
        { file: 'mimi-kedi.png', seconds: 10 },
        { mimiDir, ffmpegFn },
      );

      assert.equal(res.file, 'mimi-kedi.loop.mp4');
      assert.equal(res.source, 'mimi-kedi.png');
      assert.equal(res.seconds, 10);
      const args = calls[0];
      assert.deepEqual(args.slice(0, 6), ['-loop', '1', '-framerate', '30', '-t', '10']);
      assert.ok(args.includes('-an'));
      assert.ok(args.includes('libx264'));
      assert.match(args.join(' '), /format=yuv420p/);

      // Galeri eşleri bağlar: resim videosunu, video kaynağını bilir.
      const image = res.items.find((item) => item.file === 'mimi-kedi.png');
      const loop = res.items.find((item) => item.file === 'mimi-kedi.loop.mp4');
      assert.equal(image.role, 'image');
      assert.equal(image.loopVideo, 'mimi-kedi.loop.mp4');
      assert.equal(image.needsVideo, false);
      assert.equal(loop.role, 'loop');
      assert.equal(loop.sourceImage, 'mimi-kedi.png');
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('loop videosu olmayan resim needsVideo, elle atılan video bağımsız', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi-kedi.png'), 'img');
      await writeFile(join(mimiDir, 'mimi-dans.mp4'), 'vid');
      const { items } = await getMimiGallery({ mimiDir });
      const image = items.find((item) => item.file === 'mimi-kedi.png');
      const video = items.find((item) => item.file === 'mimi-dans.mp4');
      assert.equal(image.needsVideo, true);
      assert.equal(image.loopVideo, null);
      assert.equal(video.role, 'video');
      assert.equal(video.needsVideo, false);
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('var olan loop video onaysız ezilmez, geçersiz istekler reddedilir', async () => {
    const mimiDir = await createMimiDir();
    try {
      await writeFile(join(mimiDir, 'mimi.png'), 'img');
      await writeFile(join(mimiDir, 'mimi.loop.mp4'), 'eski');
      const ffmpegFn = async (args) => {
        await writeFile(args[args.length - 1], 'yeni');
        return { code: 0, stdout: '', stderr: '' };
      };

      await assert.rejects(
        () => convertMimiImageToLoop({ file: 'mimi.png' }, { mimiDir, ffmpegFn }),
        /zaten var/,
      );
      await convertMimiImageToLoop({ file: 'mimi.png', overwrite: true }, { mimiDir, ffmpegFn });
      assert.equal(await readFile(join(mimiDir, 'mimi.loop.mp4'), 'utf8'), 'yeni');

      await assert.rejects(
        () => convertMimiImageToLoop({ file: 'mimi.loop.mp4' }, { mimiDir, ffmpegFn }),
        /Only images/,
      );
      await assert.rejects(
        () => convertMimiImageToLoop({ file: 'yok.png' }, { mimiDir, ffmpegFn }),
        /Image not found/,
      );
      await assert.rejects(
        () => convertMimiImageToLoop({ file: 'mimi.png', seconds: 7 }, { mimiDir, ffmpegFn }),
        /Loop süresi/,
      );
    } finally {
      await rm(mimiDir, { recursive: true, force: true });
    }
  });

  test('klasörü açma işletim sistemi çağrısını yolla yapar', async () => {
    const base = await createMimiDir();
    const mimiDir = join(base, 'mimi-galeri');
    try {
      const opened = [];
      const result = await openMimiFolder({}, { mimiDir, openFn: (path) => { opened.push(path); return true; } });
      assert.equal(result.ok, true);
      assert.deepEqual(opened, [result.path]);
      assert.ok((await stat(mimiDir)).isDirectory());
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
