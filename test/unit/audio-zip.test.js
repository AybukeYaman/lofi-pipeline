/**
 * prep/audio-zip.js — müzik klasörüne bırakılan zip'lerin açılması — ve bunun
 * API'ye bağlanışı (getProject / uploadProjectAudio).
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { ZIP_ARCHIVE_DIR, audioNameOf, hasAudioZips, unpackAudioZips } from '../../prep/audio-zip.js';
import { getProject, uploadProjectAudio } from '../../server/project-api.js';
import { tempDir } from '../helpers/fixtures.js';
import { makeZip } from '../helpers/zip-fixture.js';

const entry = (name, isDirectory = false) => ({ name, isDirectory });

describe('audioNameOf', () => {
  test('yalnızca müzik; klasör yolu atılır, ad korunur', () => {
    assert.equal(audioNameOf(entry('Albüm/CD1/01 Şarkı.mp3')), '01 Şarkı.mp3');
    assert.equal(audioNameOf(entry('Albüm\\02 İki.M4A')), '02 İki.m4a');
    assert.equal(audioNameOf(entry('wav-parca.wav')), 'wav-parca.wav');
  });

  test('müzik olmayanlar, klasörler ve macOS artıkları atlanır', () => {
    assert.equal(audioNameOf(entry('kapak.jpg')), null);
    assert.equal(audioNameOf(entry('liste.txt')), null);
    assert.equal(audioNameOf(entry('klasor/', true)), null);
    assert.equal(audioNameOf(entry('__MACOSX/Albüm/._01.mp3')), null);
    assert.equal(audioNameOf(entry('._gizli.mp3')), null);
    assert.equal(audioNameOf(entry('.mp3')), null);
  });

  test('zip-slip: ../ içeren yol yalnızca dosya adına iner', () => {
    assert.equal(audioNameOf(entry('../../Windows/System32/x.mp3')), 'x.mp3');
    assert.equal(audioNameOf(entry('..\\..\\x.mp3')), 'x.mp3');
  });

  test('Windows\'ta geçersiz karakterler ve ayrılmış adlar düzeltilir', () => {
    assert.equal(audioNameOf(entry('a:b*c?.mp3')), 'a_b_c_.mp3');
    assert.equal(audioNameOf(entry('con.mp3')), '_con.mp3');
    assert.equal(audioNameOf(entry('nokta..mp3')), 'nokta.mp3');
  });
});

describe('unpackAudioZips', () => {
  let root;
  let n = 0;
  before(async () => { root = await tempDir('audio-zip'); });
  after(() => root?.cleanup());

  /** Boş bir müzik klasörü. */
  async function audioDir() {
    const dir = root.path(`a${n++}`);
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const names = async (dir) => (await readdir(dir)).sort();

  test('zip açılır, parçalar doğal sırayla eklenir, zip arşive taşınır', async () => {
    const dir = await audioDir();
    await makeZip(join(dir, 'albüm.zip'), [
      { name: 'Albüm/10 on.mp3', data: 'on' },
      { name: 'Albüm/02 iki.mp3', data: 'iki' },
      { name: 'Albüm/01 bir.mp3', data: 'bir' },
      { name: 'Albüm/kapak.jpg', data: 'resim' },
      { name: '__MACOSX/Albüm/._01 bir.mp3', data: 'x' },
    ]);

    assert.equal(await hasAudioZips(dir), true);
    const result = await unpackAudioZips(dir);

    assert.deepEqual(result.files, ['01 bir.mp3', '02 iki.mp3', '10 on.mp3']);
    assert.equal(await readFile(join(dir, '02 iki.mp3'), 'utf8'), 'iki');
    assert.deepEqual(await names(dir), ['01 bir.mp3', '02 iki.mp3', '10 on.mp3', ZIP_ARCHIVE_DIR]);
    assert.deepEqual(await readdir(join(dir, ZIP_ARCHIVE_DIR)), ['albüm.zip']);
    assert.equal(await hasAudioZips(dir), false, 'açılan zip bir daha açılmaz');
    assert.deepEqual((await unpackAudioZips(dir)).files, []);
  });

  test('aynı adlı parça ezilmez; ikinci zip de açılır', async () => {
    const dir = await audioDir();
    await writeFile(join(dir, '01 bir.mp3'), 'ESKI');
    await makeZip(join(dir, 'a.zip'), [{ name: '01 bir.mp3', data: 'YENI-A' }]);
    await makeZip(join(dir, 'b.zip'), [{ name: 'x/01 bir.mp3', data: 'YENI-B' }, { name: 'x/02.mp3', data: 'b2' }]);

    const result = await unpackAudioZips(dir);
    assert.equal(await readFile(join(dir, '01 bir.mp3'), 'utf8'), 'ESKI');
    assert.deepEqual(result.files, ['01 bir (1).mp3', '01 bir (2).mp3', '02.mp3']);
    assert.equal(result.archives.length, 2);
  });

  test('içinde müzik olmayan zip arşive taşınır ve bildirilir', async () => {
    const dir = await audioDir();
    await makeZip(join(dir, 'resimler.zip'), [{ name: 'kapak.jpg', data: 'x' }]);
    const result = await unpackAudioZips(dir);

    assert.deepEqual(result.files, []);
    assert.equal(result.archives[0].noAudio, true);
    assert.deepEqual(await readdir(join(dir, ZIP_ARCHIVE_DIR)), ['resimler.zip']);
  });

  test('bozuk zip yerinde kalır ve hata bildirilir; diğer zip\'ler etkilenmez', async () => {
    const dir = await audioDir();
    await writeFile(join(dir, 'bozuk.zip'), 'zip degil '.repeat(20));
    await makeZip(join(dir, 'saglam.zip'), [{ name: 'a.mp3', data: 'a' }]);

    const result = await unpackAudioZips(dir);
    assert.deepEqual(result.files, ['a.mp3']);
    const broken = result.archives.find((a) => a.zip === 'bozuk.zip');
    assert.match(broken.error, /zip/i);
    assert.ok((await names(dir)).includes('bozuk.zip'), 'bozuk zip silinmez ya da taşınmaz');
  });

  test('yarıda hata: o zip\'ten gelen parçalar geri alınır (ya hep ya hiç)', async () => {
    const dir = await audioDir();
    await makeZip(join(dir, 'yarim.zip'), [
      { name: '01.mp3', data: 'iyi' },
      { name: '02.mp3', data: 'kotu', badCrc: true },
    ]);
    const result = await unpackAudioZips(dir);

    assert.match(result.archives[0].error, /CRC/);
    assert.deepEqual(result.files, []);
    assert.deepEqual(await names(dir), ['yarim.zip'], '01.mp3 geri alınmış olmalı');
  });

  test('klasör yoksa hata atmaz', async () => {
    const missing = root.path('olmayan');
    assert.equal(await hasAudioZips(missing), false);
    assert.deepEqual(await unpackAudioZips(missing), { files: [], archives: [] });
  });

  test('aynı klasör için eşzamanlı çağrı parçaları ikilemez', async () => {
    const dir = await audioDir();
    await makeZip(join(dir, 'a.zip'), [{ name: '01.mp3', data: 'x' }, { name: '02.mp3', data: 'y' }]);
    const [first, second] = await Promise.all([unpackAudioZips(dir), unpackAudioZips(dir)]);

    assert.equal(first.files.length + second.files.length, 2);
    assert.deepEqual((await names(dir)).filter((f) => f.endsWith('.mp3')), ['01.mp3', '02.mp3']);
  });
});

describe('API: zip müzik yükleme ve klasöre bırakılan zip', () => {
  let videosDir;
  let n = 0;
  before(async () => { videosDir = await tempDir('audio-zip-api'); });
  after(() => videosDir?.cleanup());

  async function project() {
    const name = `p${n++}`;
    const dir = videosDir.path(name);
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'project.json'), JSON.stringify({ clip: '', audioDir: './audio' }));
    return { name, dir };
  }
  const options = () => ({ videosDir: videosDir.dir });

  test('klasöre elle bırakılan zip, proje açılınca (sayfa yenilenince) açılır', async () => {
    const { name, dir } = await project();
    await makeZip(join(dir, 'audio', 'albüm.zip'), [{ name: '02 b.mp3', data: 'b' }, { name: '01 a.mp3', data: 'a' }]);

    const loaded = await getProject(name, options());
    assert.equal(loaded.audioCount, 2);
    assert.deepEqual(loaded.audioZip.files, ['01 a.mp3', '02 b.mp3']);

    // "Eklediğim sıra" için kayda geçti.
    const json = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.deepEqual(json.workflow.audioAdded, ['01 a.mp3', '02 b.mp3']);

    // Sonraki okumada zip yok: bildirim bir kez gelir.
    const again = await getProject(name, options());
    assert.equal(again.audioCount, 2);
    assert.equal(Object.hasOwn(again, 'audioZip'), false);
  });

  test('arayüzden yüklenen zip de aynı yoldan açılır', async () => {
    const { name, dir } = await project();
    await makeZip(join(dir, 'tmp.zip'), [{ name: 'x/a.mp3', data: 'a' }, { name: 'x/b.wav', data: 'b' }]);
    const bytes = await readFile(join(dir, 'tmp.zip'));

    const result = await uploadProjectAudio(
      name, { name: 'müzikler.zip', data: `data:application/zip;base64,${bytes.toString('base64')}` }, options(),
    );
    assert.equal(result.audioCount, 2);
    assert.deepEqual(result.audioZip.files, ['a.mp3', 'b.wav']);
    assert.deepEqual(
      (await readdir(join(dir, 'audio', ZIP_ARCHIVE_DIR))), ['müzikler.zip'],
    );
  });

  test('bozuk zip yüklemesi hata DEĞİL: proje döner, audioZip.archives[].error dolu, zip yerinde', async () => {
    const { name, dir } = await project();
    const result = await uploadProjectAudio(
      name, { name: 'bozuk.zip', data: Buffer.from('zip degil '.repeat(20)).toString('base64') }, options(),
    );
    assert.equal(result.audioCount, 0);
    assert.ok(result.audioZip.archives[0].error);
    assert.ok((await readdir(join(dir, 'audio'))).includes('bozuk.zip'));
  });

  test('zip yoksa yanıtta audioZip alanı hiç olmaz', async () => {
    const { name } = await project();
    assert.equal(Object.hasOwn(await getProject(name, options()), 'audioZip'), false);
  });
});
