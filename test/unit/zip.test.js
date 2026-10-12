/**
 * core/zip.js — zip okuyucu (dış bağımlılık yok). Fixture'lar test/helpers/zip-fixture.js ile
 * yazılıyor; ayrıca sistemdeki gerçek bir arşivleyiciyle (tar) üretilen zip de okunuyor.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { ZipError, extractZipEntry, listZipEntries } from '../../core/zip.js';
import { tempDir } from '../helpers/fixtures.js';
import { makeZip } from '../helpers/zip-fixture.js';

describe('core/zip.js', () => {
  let dir;
  before(async () => { dir = await tempDir('zip'); });
  after(() => dir?.cleanup());

  const big = Buffer.alloc(300_000, 'abc'); // iyi sıkışır

  test('deflate ve stored girdileri listeler, açar; içerik birebir aynı', async () => {
    const zip = await makeZip(dir.path('a.zip'), [
      { name: 'klasor/', data: '' },
      { name: 'klasor/01-bir.mp3', data: big },
      { name: 'depolanan.txt', data: 'merhaba', method: 'store' },
      { name: 'bos.txt', data: '' },
    ]);
    const entries = await listZipEntries(zip);

    assert.deepEqual(entries.map((e) => e.name), ['klasor/', 'klasor/01-bir.mp3', 'depolanan.txt', 'bos.txt']);
    assert.deepEqual(entries.map((e) => e.isDirectory), [true, false, false, false]);
    assert.ok(entries[1].compressedSize < entries[1].size / 10, 'gerçekten sıkışmış olmalı');

    await extractZipEntry(zip, entries[1], dir.path('out-big.mp3'));
    await extractZipEntry(zip, entries[2], dir.path('out-store.txt'));
    await extractZipEntry(zip, entries[3], dir.path('out-empty.txt'));
    assert.ok((await readFile(dir.path('out-big.mp3'))).equals(big));
    assert.equal(await readFile(dir.path('out-store.txt'), 'utf8'), 'merhaba');
    assert.equal((await readFile(dir.path('out-empty.txt'))).length, 0);
  });

  test('Türkçe karakterli ad UTF-8 bayrağıyla ve bayraksız (UTF-8 baytlarıyla) doğru okunur', async () => {
    const zip = await makeZip(dir.path('tr.zip'), [
      { name: 'Şarkı – Işık.mp3', data: 'x' },
      { name: 'Çalışma.mp3', data: 'y', utf8: false },
    ]);
    assert.deepEqual((await listZipEntries(zip)).map((e) => e.name), ['Şarkı – Işık.mp3', 'Çalışma.mp3']);
  });

  test('zip sonundaki açıklama (comment) okumayı bozmaz', async () => {
    const zip = await makeZip(dir.path('comment.zip'), [{ name: 'a.mp3', data: 'x' }], { comment: 'x'.repeat(5000) });
    assert.equal((await listZipEntries(zip)).length, 1);
  });

  test('CRC uyuşmayan girdi hata verir (bozuk dosya sessizce kalmaz)', async () => {
    const zip = await makeZip(dir.path('crc.zip'), [{ name: 'a.mp3', data: 'icerik', badCrc: true }]);
    const [entry] = await listZipEntries(zip);
    await assert.rejects(
      extractZipEntry(zip, entry, dir.path('crc.out')),
      (error) => error instanceof ZipError && /CRC/.test(error.message),
    );
  });

  test('şifreli girdi anlaşılır hatayla reddedilir', async () => {
    const zip = await makeZip(dir.path('enc.zip'), [{ name: 'a.mp3', data: 'x', encrypted: true }]);
    const [entry] = await listZipEntries(zip);
    await assert.rejects(extractZipEntry(zip, entry, dir.path('enc.out')), /Şifreli/);
  });

  test('zip olmayan / kesik dosya ZipError verir', async () => {
    await writeFile(dir.path('text.zip'), 'bu bir zip degil, sadece yazi '.repeat(10));
    await assert.rejects(listZipEntries(dir.path('text.zip')), ZipError);
    await writeFile(dir.path('tiny.zip'), 'PK');
    await assert.rejects(listZipEntries(dir.path('tiny.zip')), ZipError);

    const full = await makeZip(dir.path('full.zip'), [{ name: 'a.mp3', data: big }]);
    const bytes = await readFile(full);
    await writeFile(dir.path('cut.zip'), bytes.subarray(0, bytes.length - 40));
    await assert.rejects(listZipEntries(dir.path('cut.zip')), ZipError);
  });

  test('başlıkta yazandan büyük açılan veri durdurulur (yalan söyleyen zip diski doldurmaz)', async () => {
    const zip = await makeZip(dir.path('lie.zip'), [{ name: 'a.mp3', data: big }]);
    const [entry] = await listZipEntries(zip);
    await assert.rejects(
      extractZipEntry(zip, { ...entry, size: 1000 }, dir.path('lie.out')),
      (error) => error instanceof ZipError && /büyük/.test(error.message),
    );
  });

  test('gerçek bir arşivleyiciyle (tar / Windows Compress-Archive) üretilen zip de okunur', async (t) => {
    const src = dir.path('real');
    await mkdir(src);
    await writeFile(`${src}/gercek.mp3`, big);
    await writeFile(`${src}/not.txt`, 'x');

    let made = spawnSync('tar', ['-a', '-c', '-f', dir.path('real.zip'), '-C', src, 'gercek.mp3', 'not.txt']).status === 0;
    if (!made && process.platform === 'win32') {
      // Windows PowerShell 5.1 zip'i: yollar ters bölülü, Gezgin/Compress-Archive biçimi.
      made = spawnSync('powershell', [
        '-NoProfile', '-Command',
        `Compress-Archive -Path '${src}\*' -DestinationPath '${dir.path('real.zip')}' -Force`,
      ]).status === 0;
    }
    if (!made) { t.skip('sistemde zip üretecek arşivleyici yok'); return; }

    const entries = await listZipEntries(dir.path('real.zip'));
    const mp3 = entries.find((e) => e.name.endsWith('gercek.mp3'));
    assert.ok(mp3, `girdiler: ${entries.map((e) => e.name)}`);
    await extractZipEntry(dir.path('real.zip'), mp3, dir.path('real.out'));
    assert.ok((await readFile(dir.path('real.out'))).equals(big));
  });
});
