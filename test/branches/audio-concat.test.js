/**
 * P4 — Ses birleştirme (02-audio-concat.js), yapay veriyle.
 *
 * Eski demuxer yolu ilk dosyadan sonrakilerin encoder priming örneklerini
 * atmıyordu: 15 parçada AAC kopyada +373 ms, Opus encode'da +206 ms kayma; süre
 * kontrolü (±0.5 sn, probe'a bakıyor) hiçbirini görmüyordu. concat filtresi
 * stereo'yu mono'ya indiriyordu. Bu testler üçünü de ölçer.
 *
 * Kayma ölçümü: her parça tam 10.000 sn, başında farklı frekanslı 20 ms tık.
 * Çıktıdaki tıkların örnek düzeyindeki konumu manifest `startSeconds` ile
 * karşılaştırılır.
 */

import assert from 'node:assert/strict';
import { mkdir, open, stat } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';

import { ffmpeg } from '../../core/ffmpeg.js';
import { DURATION_TOLERANCE, measureDecodedDuration, probe } from '../../core/probe.js';
import { concatAudio } from '../../steps/02-audio-concat.js';
import { channelStats, findOnsets, tempDir } from '../helpers/fixtures.js';

const TRACKS = 15;
const TRACK_SECONDS = 10;
/** İzin verilen başlangıç sapması (ms). Eski yollarda son parçada 206–373 ms. */
const MAX_DRIFT_MS = 2;

describe('ses birleştirme', () => {
  let dir;

  before(async () => { dir = await tempDir('audio'); });
  after(() => dir?.cleanup());

  /** Klasöre `count` tık parçası üretir. Frekanslar farklı — MD5 duplike elemesine takılmasın. */
  const makeAlbum = async (name, { rate, channels, codec, container }, count = TRACKS) => {
    const folder = dir.path(name);
    await mkdir(folder);
    for (let i = 0; i < count; i++) {
      const hz = 800 + i * 40;
      await ffmpeg([
        '-f', 'lavfi', '-i', `aevalsrc='if(lt(t,0.02),0.5*sin(2*PI*${hz}*t),0)':s=${rate}:d=${TRACK_SECONDS + 1}`,
        '-af', `atrim=end_sample=${TRACK_SECONDS * rate}`,
        '-ac', String(channels), ...codec, ...(container ? ['-f', container] : []),
        '-y', `${folder}/${String(i + 1).padStart(2, '0')}.m4a`,
      ]);
    }
    return folder;
  };

  /** Birleştir, tıkları bul, manifest'le karşılaştır. */
  const measureDrift = async (folder, name) => {
    const r = await concatAudio({ audioDir: folder, outputPath: dir.path(`${name}.m4a`) });
    const { onsets } = await findOnsets(r.output, { dir });
    assert.equal(onsets.length, TRACKS, `${name}: bulunan tık ${onsets.length}`);
    const driftMs = onsets.map((t, i) => Math.round((t - r.tracks[i].startSeconds) * 1000 * 10) / 10);
    return { r, driftMs };
  };

  for (const [name, spec] of [
    // Eski beyaz liste bu girdiyi -c copy ile birleştiriyordu (+373 ms).
    ['AAC 48k stereo (eski -c copy yolu)', { rate: 48000, channels: 2, codec: ['-c:a', 'aac', '-b:a', '192k'] }],
    // Yayınlanan albümün biçimi: .m4a içinde Opus (+206 ms).
    ['Opus 48k stereo .m4a (bu albüm)', { rate: 48000, channels: 2, codec: ['-c:a', 'libopus', '-b:a', '128k'], container: 'mp4' }],
  ]) {
    test(`${name}: 15 parçada başlangıç kayması ≤ ${MAX_DRIFT_MS} ms`, async () => {
      const folder = await makeAlbum(name.replace(/\W+/g, '-'), spec);
      const { r, driftMs } = await measureDrift(folder, name.replace(/\W+/g, '-'));

      assert.equal(r.codec.method, 'filter');
      assert.ok(
        driftMs.every((d) => Math.abs(d) <= MAX_DRIFT_MS),
        `kayma (ms): ${driftMs.join(' ')}`,
      );
      // Manifest süresi = dosyanın ÇÖZÜLEN süresi (probe değil). Opus .m4a çözülünce
      // dosya başına +13.5 ms veriyor (kaynak tam 10.000 sn) — tıklar yine yerinde,
      // çünkü damga bu gerçek süreden hesaplanıyor.
      for (const t of r.tracks) {
        assert.equal(t.duration, await measureDecodedDuration(t.file));
        assert.ok(Math.abs(t.duration - TRACK_SECONDS) < 0.03, `parça süresi ${t.duration}`);
      }
      // Başlık, gerçek ses ve parçaların toplamı aynı şeyi söylüyor.
      const decoded = await measureDecodedDuration(r.output);
      const sum = r.tracks.reduce((acc, t) => acc + t.duration, 0);
      assert.ok(Math.abs(decoded - r.duration) <= DURATION_TOLERANCE, `probe ${r.duration}, çözülen ${decoded}`);
      assert.ok(Math.abs(decoded - sum) <= DURATION_TOLERANCE, `çözülen ${decoded}, parça toplamı ${sum}`);
    });
  }

  test('mono 44.1k + stereo 48k: stereo korunur, mono seviyesi düşmez', async () => {
    const folder = dir.path('mixed');
    await mkdir(folder);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'sine=f=300:d=3:sample_rate=44100', '-ac', '1', '-c:a', 'aac', '-b:a', '192k',
      '-y', `${folder}/01.m4a`,
    ]);
    await ffmpeg([
      '-f', 'lavfi', '-i', 'sine=f=500:d=3:sample_rate=48000',
      '-f', 'lavfi', '-i', 'sine=f=900:d=3:sample_rate=48000',
      '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k',
      '-y', `${folder}/02.m4a`,
    ]);

    const source = await channelStats(`${folder}/01.m4a`, { start: 1, duration: 1 });
    const sourceStereo = await channelStats(`${folder}/02.m4a`, { start: 1, duration: 1 });
    assert.deepEqual(sourceStereo.map((c) => Math.round(c.hz / 10) * 10), [500, 900], 'fixture');

    const r = await concatAudio({ audioDir: folder, outputPath: dir.path('mixed.m4a') });
    assert.deepEqual([r.format.sampleRate, r.format.channels], [48000, 2]);

    const mono = await channelStats(r.output, { start: 1, duration: 1 });
    const stereo = await channelStats(r.output, { start: 4, duration: 1 });

    assert.deepEqual(stereo.map((c) => Math.round(c.hz / 10) * 10), [500, 900], 'stereo bölüm L/R');
    assert.deepEqual(mono.map((c) => Math.round(c.hz / 10) * 10), [300, 300], 'mono bölüm iki kanala');
    for (const ch of mono) {
      assert.ok(Math.abs(ch.rmsDb - source[0].rmsDb) < 0.5, `mono seviye ${ch.rmsDb} vs kaynak ${source[0].rmsDb} dB`);
    }
  });

  test('sonu kesik dosya: probe/çözülen farkı yakalanır, build durur', async () => {
    const folder = dir.path('truncated');
    await mkdir(folder);
    for (const [name, hz] of [['01', 400], ['02', 600]]) {
      await ffmpeg([
        '-f', 'lavfi', '-i', `sine=f=${hz}:d=20:sample_rate=48000`, '-ac', '2',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', `${folder}/${name}.m4a`,
      ]);
    }
    const damaged = `${folder}/02.m4a`;
    const handle = await open(damaged, 'r+');
    await handle.truncate(Math.floor((await stat(damaged)).size / 2));
    await handle.close();

    // Önkoşul: başlık hâlâ 20 sn diyor.
    assert.equal((await probe(damaged)).duration, 20);

    await assert.rejects(
      concatAudio({ audioDir: folder, outputPath: dir.path('truncated.m4a') }),
      /"02\.m4a" bozuk ya da kesik olabilir: başlık 20\.00 sn diyor, çözülebilen ses 9\.\d\d sn/,
    );
  });
});
