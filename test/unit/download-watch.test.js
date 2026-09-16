/**
 * prep/download-watch.js (saf izleme mantığı) + core/downloads.js (klasör bulma, taşıma)
 * + core/files.js uniqueFileName.
 */

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { moveFile, resolveDownloadsDir, snapshotDir } from '../../core/downloads.js';
import { uniqueFileName } from '../../core/files.js';
import {
  DOWNLOAD_AUDIO_EXTENSIONS, RECENT_MS, RECENT_WINDOW_MINUTES, STABLE_MS, baselineOf, cleanDownloadName, createDownloadWatcher, diffSnapshots,
} from '../../prep/download-watch.js';
import { tempDir } from '../helpers/fixtures.js';

const MP3 = ['.mp3'];
const empty = (baseline = []) => ({ baseline: new Set(baseline), pending: new Map() });
const file = (name, size = 100) => ({ name, size });

/** Aynı anlık görüntüyü art arda uygular; her turun hazır listesini döndürür. */
function run(snapshots, { start = empty(), step = 1000 } = {}) {
  let state = start;
  return snapshots.map((snapshot, i) => {
    const result = diffSnapshots(state, snapshot, { now: i * step, extensions: MP3 });
    state = result.state;
    return result.ready;
  });
}

describe('diffSnapshots', () => {
  test('yeni mp3 boyutu STABLE_MS boyunca değişmezse bir kez hazır olur', () => {
    const s = [file('a.mp3')];
    assert.deepEqual(run([s, s, s]), [[], [], ['a.mp3']]);
    assert.ok(STABLE_MS > 1000 && STABLE_MS <= 2000, 'testteki 1 sn adımıyla üçüncü turda hazır');
  });

  test('boyutu hâlâ büyüyen dosya hazır sayılmaz', () => {
    assert.deepEqual(run([[file('a.mp3', 10)], [file('a.mp3', 20)], [file('a.mp3', 30)], [file('a.mp3', 30)]]), [[], [], [], []]);
  });

  test('başlangıçta var olan dosyalara dokunulmaz; silinip aynı adla yeniden inerse yeni sayılır', () => {
    const start = empty(['eski.mp3']);
    assert.deepEqual(run([[file('eski.mp3')], [file('eski.mp3')], [file('eski.mp3')]], { start }), [[], [], []]);
    assert.deepEqual(run([[], [file('eski.mp3')], [file('eski.mp3')], [file('eski.mp3')]], { start }), [[], [], [], ['eski.mp3']]);
  });

  test('Chrome .crdownload ve Firefox 0 bayt + .part yarım indirmeleri beklenir', () => {
    const chrome = [file('a.mp3.crdownload', 50)];
    const firefox = [file('b.mp3', 0), file('b.mp3.part', 50)];
    const firefoxBitmemis = [file('c.mp3', 80), file('c.mp3.part', 80)];
    assert.deepEqual(run([chrome, chrome, chrome]), [[], [], []]);
    assert.deepEqual(run([firefox, firefox, firefox]), [[], [], []]);
    assert.deepEqual(run([firefoxBitmemis, firefoxBitmemis, firefoxBitmemis]), [[], [], []]);
  });

  test('izin verilmeyen uzantılar yok sayılır (büyük harf uzantı kabul)', () => {
    const s = [file('x.wav'), file('y.MP3'), file('z.zip')];
    assert.deepEqual(run([s, s, s]), [[], [], ['y.MP3']]);
  });
});

describe('cleanDownloadName ve sabitler', () => {
  test('site etiketi ve tekrar indirme eki atılır; ad boş kalırsa orijinal döner', () => {
    assert.equal(cleanDownloadName('静かな朝の練習 [usesuno.com] (1)'), '静かな朝の練習');
    assert.equal(cleanDownloadName('Quiet Moments (2)'), 'Quiet Moments');
    assert.equal(cleanDownloadName('Track (Live) Mix'), 'Track (Live) Mix', 'sondaki sayı değilse dokunulmaz');
    assert.equal(cleanDownloadName('[usesuno.com]'), '[usesuno.com]');
  });

  test('süre seçenekleri 5/10/15 dk; varsayılan 15 dk; m4a ve wav da alınır', () => {
    assert.deepEqual(RECENT_WINDOW_MINUTES, [5, 10, 15]);
    assert.equal(RECENT_MS, 15 * 60 * 1000);
    assert.deepEqual(DOWNLOAD_AUDIO_EXTENSIONS, ['.mp3', '.m4a', '.wav']);
  });
});

describe('baselineOf (başlangıçta duran dosyalar)', () => {
  test('son 15 dk içinde inenler alınır (baseline dışı); eskiler ve zamanı bilinmeyenler dokunulmaz', () => {
    const now = 10 * RECENT_MS;
    const snapshot = [
      { name: 'az-once.mp3', mtimeMs: now - 60_000 },
      { name: 'tam-sinir.mp3', mtimeMs: now - RECENT_MS },
      { name: 'eski.mp3', mtimeMs: now - RECENT_MS - 1 },
      { name: 'zamansiz.mp3' },
    ];
    assert.deepEqual([...baselineOf(snapshot, { now })].sort(), ['eski.mp3', 'zamansiz.mp3']);
  });
});

describe('createDownloadWatcher', () => {
  test('açılmadan önce inmiş yeni dosyalar indirilme sırasıyla hazır olur', async () => {
    const wall = 5 * RECENT_MS;
    const listing = [
      { name: 'b-ilk-inen.mp3', size: 10, mtimeMs: wall - 120_000 },
      { name: 'a-sonra-inen.mp3', size: 10, mtimeMs: wall - 30_000 },
      { name: 'dun.mp3', size: 10, mtimeMs: wall - RECENT_MS * 2 },
    ];
    let now = 0;
    const watcher = createDownloadWatcher({ dir: 'D:\\dl', snapshotFn: async () => listing, nowFn: () => (now += 1000), wallClockFn: () => wall });
    await watcher.start();
    assert.deepEqual(await watcher.poll(), []);
    assert.deepEqual(await watcher.poll(), []);
    assert.deepEqual(await watcher.poll(), [join('D:\\dl', 'b-ilk-inen.mp3'), join('D:\\dl', 'a-sonra-inen.mp3')]);
  });

  test('start baseline alır, poll tam yol döndürür', async () => {
    let listing = [file('eski.mp3')];
    let now = 0;
    const watcher = createDownloadWatcher({ dir: 'D:\\dl', snapshotFn: async () => listing, nowFn: () => (now += 1000) });
    await watcher.start();
    listing = [file('eski.mp3'), file('yeni.mp3')];
    assert.deepEqual(await watcher.poll(), []);
    assert.deepEqual(await watcher.poll(), []);
    assert.deepEqual(await watcher.poll(), [join('D:\\dl', 'yeni.mp3')]);
  });
});

describe('core/downloads + uniqueFileName', () => {
  let root;
  after(() => root?.cleanup());

  test('resolveDownloadsDir: kayıt defteri değeri %VAR% açılır; hata ya da boş çıktıda USERPROFILE\\Downloads', () => {
    const env = { USERPROFILE: 'C:\\Users\\a b' };
    const reg = '\r\nHKEY_CURRENT_USER\\...\r\n    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\İndirmeler\r\n';
    assert.equal(resolveDownloadsDir({ env, platform: 'win32', execFn: () => reg }), 'C:\\Users\\a b\\İndirmeler');
    assert.equal(resolveDownloadsDir({ env, platform: 'win32', execFn: () => { throw new Error('reg yok'); } }), join('C:\\Users\\a b', 'Downloads'));
    assert.equal(resolveDownloadsDir({ env, platform: 'win32', execFn: () => '' }), join('C:\\Users\\a b', 'Downloads'));
  });

  test('uniqueFileName numaralar; moveFile taşır (kaynak kalmaz), çakışmada "(1)" ekler', async () => {
    root ??= await tempDir('downloads');
    const src = root.path('src');
    const dest = root.path('dest');
    await mkdir(src);
    await mkdir(dest);
    await writeFile(join(dest, '01-Ad.mp3'), 'var');
    assert.equal(await uniqueFileName(dest, '01-Ad.mp3'), '01-Ad (1).mp3');
    assert.equal(await uniqueFileName(dest, 'yok.mp3'), 'yok.mp3');

    await writeFile(join(src, 'Ad.mp3'), 'yeni');
    assert.equal(await moveFile(join(src, 'Ad.mp3'), dest, '01-Ad.mp3'), '01-Ad (1).mp3');
    assert.deepEqual(await readdir(src), []);
    assert.equal(await readFile(join(dest, '01-Ad.mp3'), 'utf8'), 'var', 'eski dosyanın üzerine yazılmaz');
    assert.equal(await readFile(join(dest, '01-Ad (1).mp3'), 'utf8'), 'yeni');
  });

  test('snapshotDir: alt klasörler hariç ad + boyut; olmayan klasör boş', async () => {
    root ??= await tempDir('downloads');
    const dir = root.path('snap');
    await mkdir(join(dir, 'alt'), { recursive: true });
    await writeFile(join(dir, 'a.mp3'), '12345');
    const [only, ...rest] = await snapshotDir(dir);
    assert.deepEqual(rest, []);
    assert.equal(only.name, 'a.mp3');
    assert.equal(only.size, 5);
    assert.ok(Math.abs(Date.now() - only.mtimeMs) < 60_000, 'mtimeMs gerçek değiştirilme zamanı');
    assert.deepEqual(await snapshotDir(root.path('yok')), []);
  });
});
