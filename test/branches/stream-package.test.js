/**
 * Yayın paketi: 24/7 yayının albümü (background.mp4 + music/*.m4a).
 *
 * Buradaki iddialar yayın tarafının SÖZLEŞMESİ — gevşetilmemeli:
 *   - background.mp4: h264, 1280x720, 24 fps, SESSİZ, kısa döngü
 *   - music/: yalnızca .m4a (başka uzantı yayın tarafında sessizce yok sayılır)
 *   - dosya adı = ekranda görünen parça adı, numara/önek yok
 *   - canlı dizine atomik giriş (.staging → tek rename)
 *   - var olan albümün içi değiştirilmez, yeni sürüm adı alınır
 *
 * Gerçek ffmpeg çalışır; veri küçük tutulmuştur.
 */

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { runBuild } from '../../build.js';
import { loadProject } from '../../core/config.js';
import { probe } from '../../core/probe.js';
import { STAGING_DIR, STREAM_PROFILE, TRACK_EXTENSION, displayName, screenName, takeSuffix } from '../../steps/07-stream-package.js';
import { makeDriftingClip, makeTone, tempDir } from '../helpers/fixtures.js';

describe('yayın paketi — 24/7 yayın albümü', () => {
  let dir;
  let config;
  let report;
  let streamerDir;

  before(async () => {
    dir = await tempDir('stream-package');
    streamerDir = dir.path('music-source');
    await mkdir(streamerDir, { recursive: true });
    await mkdir(dir.path('audio'));

    await makeDriftingClip(dir.path('clip.mp4'), { width: 640, height: 360 });
    // Farklı kaynak biçimleri: biri .m4a/AAC (kopyalanmalı), biri .wav (kodlanmalı).
    await makeTone(dir.path('audio/01-midnight-window.m4a'), { seconds: 3, frequency: 440 });
    await makeTone(dir.path('audio/02-rain-on-the-glass.wav'), { seconds: 2, frequency: 660, codec: 'pcm' });

    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      names: { '01-midnight-window': 'Midnight Window' },
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast' },
      output: { dir: './out' },
      stream: { dir: streamerDir, album: 'test-album' },
    }));

    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config);
  });
  after(() => dir?.cleanup());

  test('render istenmedi → uzun video HİÇ üretilmez', async () => {
    assert.equal(report.rendered, false);
    assert.equal(report.mode, 'stream-package');
    assert.equal(await exists(config.output.video), false, 'final_ambient.mp4 yazılmamalı');
    // Montaj ve ses birleştirme adımları hiç çalışmaz; yalnızca paket.
    assert.deepEqual(report.steps.map((s) => s.tag), ['07']);
  });

  test('background.mp4 sözleşmeye uyar: 1280x720, 24 fps, h264, SESSİZ', async () => {
    const background = await probe(join(report.streamPackage.dir, 'background.mp4'));
    assert.equal(background.width, STREAM_PROFILE.width);
    assert.equal(background.height, STREAM_PROFILE.height);
    assert.equal(Math.round(background.fps), STREAM_PROFILE.fps);
    assert.equal(background.videoCodec, 'h264');
    assert.equal(background.hasAudio, false, 'arka planda ses olmamalı');
    assert.ok(background.duration < 30, `döngü kısa olmalı: ${background.duration} sn`);
  });

  test('music/ yalnızca .m4a içerir ve hepsi AAC', async () => {
    const musicDir = join(report.streamPackage.dir, 'music');
    const files = await readdir(musicDir);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith('.m4a')), `yalnızca .m4a: ${files.join(', ')}`);
    for (const file of files) {
      const info = await probe(join(musicDir, file));
      assert.equal(info.audioCodec, 'aac', file);
      assert.equal(info.hasAudio, true, file);
    }
  });

  test('dosya adı ekranda görünen parça adıdır: numara/önek yok', async () => {
    const files = (await readdir(join(report.streamPackage.dir, 'music'))).sort();
    // names eşlemesi ve başlık büyütmesi tracklist ile aynı kaynaktan gelir.
    assert.deepEqual(files, ['Midnight Window.m4a', 'Rain on the Glass.m4a']);
  });

  test('zaten AAC/.m4a olan kopyalanır, diğeri kodlanır (gereksiz kayıp yok)', () => {
    const actions = Object.fromEntries(report.details['07'].tracks.map((t) => [t.name, t.action]));
    assert.equal(actions['Midnight Window'], 'copy');
    assert.equal(actions['Rain on the Glass'], 'encode');
  });

  test('yayın tarafına atomik girer: .staging kalıntısı bırakmaz', async () => {
    const album = join(streamerDir, 'test-album');
    assert.equal(report.streamPackage.published, album);
    assert.ok(await exists(join(album, 'background.mp4')));
    assert.equal((await readdir(join(album, 'music'))).length, 2);

    // Yarım albüm canlı dizine düşmesin diye .staging kullanılıyor; iş bitince
    // o albüm staging'de kalmamalı.
    const staging = join(streamerDir, STAGING_DIR);
    if (await exists(staging)) {
      assert.deepEqual(await readdir(staging), [], 'staging boşalmalı');
    }
  });

  test('yayın tarafına SÖZLEŞME DIŞI dosya konmaz', async () => {
    const album = join(streamerDir, 'test-album');
    assert.deepEqual((await readdir(album)).sort(), ['background.mp4', 'music']);
  });

  test('var olan albümün içi değiştirilmez: yeni sürüm adı alır', async () => {
    const second = await runBuild(config);
    assert.equal(second.streamPackage.album, 'test-album-v2');
    assert.equal(second.streamPackage.published, join(streamerDir, 'test-album-v2'));
    // İlk albüm olduğu gibi duruyor.
    assert.equal((await readdir(join(streamerDir, 'test-album', 'music'))).length, 2);
    assert.ok(
      second.warnings.some((w) => w.message.includes('test-album-v2')),
      'yeni ad kullanıcıya bildirilmeli',
    );
  });

  test('paketin projedeki kopyası da durur (out/stream-package)', async () => {
    const albums = await readdir(config.output.streamPackage);
    assert.ok(albums.includes('test-album'));
  });

  test('paket, render edilen videodan kat kat küçüktür', () => {
    // Asıl kazanç: yayın uzun videoyu kullanmıyor, malzemesi yetiyor.
    assert.ok(report.streamPackage.totalBytes > 0);
    assert.ok(report.streamPackage.totalBytes < 5e6, `paket küçük olmalı: ${report.streamPackage.totalBytes}`);
  });
});

describe('yayın paketi — render ile birlikte', () => {
  let dir;
  let config;
  let report;

  before(async () => {
    dir = await tempDir('stream-package-render');
    await mkdir(dir.path('audio'));
    await makeDriftingClip(dir.path('clip.mp4'), { width: 320, height: 180 });
    await makeTone(dir.path('audio/01-a.m4a'), { seconds: 4, frequency: 440 });
    await makeTone(dir.path('audio/02-b.m4a'), { seconds: 3, frequency: 660 });

    await writeFile(dir.path('project.json'), JSON.stringify({
      clip: './clip.mp4',
      audioDir: './audio',
      video: { cropBottom: 0, aspect: '16:9', preset: 'ultrafast', fadeOut: 1 },
      output: { dir: './out' },
      // Yayın tarafı yok: paket yalnızca projenin out/ klasörüne yazılır.
      stream: { dir: null, album: 'render-album' },
    }));

    config = await loadProject(dir.path('project.json'));
    report = await runBuild(config, { render: true });
  });
  after(() => dir?.cleanup());

  test('--render: hem uzun video hem paket üretilir', async () => {
    assert.equal(report.rendered, true);
    assert.ok(await exists(config.output.video));
    assert.ok(await exists(config.output.tracklist));
    assert.equal(report.streamPackage.album, 'render-album');
    // Paket kırpma onayı ve disk denetiminden sonra, montajdan (04) önce.
    assert.deepEqual(report.steps.map((s) => s.tag), ['01', '02', '07', '04', '05']);
  });

  test('stream.dir null → yayın tarafına kopyalanmaz, paket out/ altında kalır', async () => {
    assert.equal(report.streamPackage.published, null);
    assert.ok(await exists(join(config.output.streamPackage, 'render-album', 'background.mp4')));
  });

  test('render kalitesi varsayılanı CRF 21 (eski 16 bir döngü için aşırıydı)', () => {
    assert.equal(config.video.crf, 21);
  });
});

async function exists(path) {
  return readFile(path).then(() => true, async (error) => {
    if (error.code === 'EISDIR') return true;
    return false;
  });
}

describe('ekranda görünen parça adı', () => {
  test('okunur kaynak adlar olduğu gibi kalır (kullanıcının yazdığı bozulmaz)', () => {
    assert.equal(screenName('X:/a/Amber Curtains, 952 PM.m4a', {}), 'Amber Curtains, 952 PM');
    assert.equal(screenName('X:/a/After the Rain.m4a', {}), 'After the Rain');
  });

  test('okunur olmayan adlar tracklist ile aynı yoldan geçer', () => {
    assert.equal(screenName('X:/a/rain-on-the-glass [usesuno.com].m4a', {}), 'Rain on the Glass');
    assert.equal(screenName('X:/a/2 [usesuno.com].m4a', { 2: 'Before Light' }), 'Before Light');
  });

  test('sıra öneki atılır: ekranda numara görünmez', () => {
    assert.equal(screenName('X:/a/01-midnight-window.m4a', {}), 'Midnight Window');
    assert.equal(screenName('X:/a/03 - Night Drive.m4a', {}), 'Night Drive');
    // Gerçekten sayı olan ad silinmez.
    assert.equal(displayName('1979'), '1979');
  });

  test('alternatif kayıt "(Take N)" geleneğine çevrilir', () => {
    // Üretim tarafı `_1`/`_2` ile ayırıyor; mevcut albümlerde yerleşik ad
    // "(Take 2)". `_1` ilk alternatif, yani Take 2 — asıl kayıt Take 1.
    assert.equal(takeSuffix('Amber Cursor_1'), 'Amber Cursor (Take 2)');
    assert.equal(takeSuffix('Candlelight on the Keyboard_2'), 'Candlelight on the Keyboard (Take 3)');
    assert.equal(screenName('X:/a/Amber Curtains, 952 PM_1.m4a', {}), 'Amber Curtains, 952 PM (Take 2)');
    // Sondaki numara değilse dokunulmaz.
    assert.equal(takeSuffix('Mix_1_final'), 'Mix_1_final');
    assert.equal(takeSuffix('Amber Cursor'), 'Amber Cursor');
  });

  test('dosya adında kullanılamayan karakterler temizlenir', () => {
    assert.equal(displayName('Rain / Snow: Night'), 'Rain Snow Night');
    assert.equal(displayName('   '), 'track');
  });

  test('yayın tarafı yalnızca bu uzantıya bakıyor', () => {
    assert.equal(TRACK_EXTENSION, '.m4a');
  });
});
