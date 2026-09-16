/**
 * GET /api/projects/:id/music — plan (music.tracks) ile audioDir dosyalarının
 * eşleşmesi, eksik parçalar ve ses önizlemesi. ffprobe sahte.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { completeMusic, getAsset, getMusic, getProject } from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';

let base;
let videosDir;
let server;
let url;

/** Sahte ffprobe: adı "broken" olan ölçülemez. */
async function fakeProbe(path) {
  if (path.includes('broken')) throw new Error('bozuk');
  return { duration: 120.5, hasAudio: true };
}

const get = (path) => fetch(`${url}${path}`);

async function writeProject(name, { project = {}, audio = [] } = {}) {
  const dir = join(videosDir, name);
  await mkdir(join(dir, 'audio'), { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    clip: '', audioDir: './audio', video: { cropBottom: 150 }, style: 'cozy-realistic', ...project,
  }, null, 2));
  for (const file of audio) await writeFile(join(dir, 'audio', file), `audio:${file}`);
  return dir;
}

const track = (number, status, file = null) => ({ number, title: `Track ${number}`, prompt: `p${number}`, status, file });

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-music-'));
  videosDir = join(base, 'videolar');
  await mkdir(videosDir);
  const options = { videosDir };
  server = createWebServer({
    projectApi: {
      getProject: (id) => getProject(id, options),
      getMusic: (id) => getMusic(id, { videosDir, probeFn: fakeProbe }),
      completeMusic: (id, body) => completeMusic(id, body, options),
      getAsset: (id, type, file) => getAsset(id, type, file, options),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;

  await writeProject('plan', {
    project: {
      music: {
        concept: 'Rainy night',
        status: 'in_progress',
        totalTracks: 5,
        completedCount: 3,
        tracks: [
          track(1, 'completed', '01 Rain.mp3'),
          track(2, 'completed', 'gone.mp3'),
          track(3, 'completed'),
          track(4, 'pending'),
          track(5, 'completed', '..\\plan\\audio\\01 Rain.mp3'),
        ],
      },
    },
    audio: ['01 Rain.mp3', 'extra.m4a', 'broken.mp3', 'notes.txt'],
  });
});

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(base, { recursive: true, force: true });
});

describe('GET /api/projects/:id/music', () => {
  test('plan parçaları gerçek dosyalarla eşleşir; eksikler nedeniyle ayrılır', async () => {
    const response = await get('/api/projects/plan/music');
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.ready, false);
    assert.equal(body.mode, 'plan');
    assert.equal(body.status, 'in_progress');
    assert.equal(body.completedByUser, false);
    assert.equal(body.concept, 'Rainy night');
    assert.equal(body.audioDir, join(videosDir, 'plan', 'audio'));
    assert.equal(body.audioDirInsideProject, true);
    assert.deepEqual(body.summary, {
      trackCount: 5, completedCount: 4, availableCount: 1, missingCount: 4, audioFileCount: 3, unassignedFileCount: 2,
    });

    const [first, gone, noFile, pending, traversal] = body.tracks;
    assert.deepEqual(first, {
      number: 1,
      title: 'Track 1',
      prompt: 'p1',
      status: 'completed',
      file: '01 Rain.mp3',
      audio: {
        file: '01 Rain.mp3',
        size: 'audio:01 Rain.mp3'.length,
        duration: 120.5,
        previewUrl: '/api/projects/plan/assets/audio/01%20Rain.mp3',
      },
      missing: false,
      missingReason: null,
    });
    assert.equal(gone.missingReason, 'file-not-found');
    assert.equal(noFile.missingReason, 'no-file-recorded');
    assert.equal(pending.missingReason, 'not-generated');
    assert.equal(traversal.missing, true); // yol içeren kayıt dosyaya çözülmez
    assert.equal(traversal.missingReason, 'file-not-found');

    assert.deepEqual(body.audioFiles.map((audio) => [audio.file, audio.trackNumber, audio.duration]), [
      ['01 Rain.mp3', 1, 120.5],
      ['broken.mp3', null, null],
      ['extra.m4a', null, 120.5],
    ]);
  });

  test('önizleme adresi sesi doğru MIME ile sunar; listede olmayan 404', async () => {
    const body = await (await get('/api/projects/plan/music')).json();
    const preview = await get(body.tracks[0].audio.previewUrl);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await preview.text(), 'audio:01 Rain.mp3');
    assert.equal((await get('/api/projects/plan/assets/audio/extra.m4a')).headers.get('content-type'), 'audio/mp4');
    assert.equal((await get('/api/projects/plan/assets/audio/notes.txt')).status, 404);
    assert.equal((await get('/api/projects/plan/assets/audio/..%2Fproject.json')).status, 400);
  });

  test('music/complete akışı aynı; sonrası ready ve eksikler hâlâ görünür', async () => {
    const dir = await writeProject('complete', {
      project: { music: { status: 'in_progress', totalTracks: 2, tracks: [track(1, 'completed', 'a.mp3'), track(2, 'pending')] } },
      audio: ['a.mp3'],
    });
    const completed = await fetch(`${url}/api/projects/complete/music/complete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(completed.status, 200);
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).music;
    assert.equal(saved.status, 'completed_by_user');
    assert.equal(saved.completedCount, 1);

    const body = await (await get('/api/projects/complete/music')).json();
    assert.equal(body.ready, true);
    assert.equal(body.completedByUser, true);
    assert.equal(body.summary.missingCount, 1);
    assert.equal(body.tracks[1].missingReason, 'not-generated');
    const project = await (await get('/api/projects/complete')).json();
    assert.equal(project.readiness.music.ready, body.ready);
  });

  test('tüm parçalar completed ise status beklenmeden hazır (mevcut kural)', async () => {
    await writeProject('all-done', {
      project: { music: { status: 'in_progress', tracks: [track(1, 'completed', 'a.mp3')] } },
      audio: ['a.mp3'],
    });
    const body = await (await get('/api/projects/all-done/music')).json();
    assert.equal(body.ready, true);
    assert.equal(body.summary.missingCount, 0);
  });

  test('plansız proje: hazırlık ses dosyası sayısına bağlı', async () => {
    await writeProject('files-only', { audio: ['b.mp3', 'a.mp3'] });
    const body = await (await get('/api/projects/files-only/music')).json();
    assert.equal(body.mode, 'files');
    assert.equal(body.ready, true);
    assert.deepEqual(body.tracks, []);
    assert.deepEqual(body.audioFiles.map((audio) => audio.file), ['a.mp3', 'b.mp3']);
    assert.equal(body.summary.unassignedFileCount, 0);

    const dir = join(videosDir, 'no-audio');
    await mkdir(dir);
    await writeFile(join(dir, 'project.json'), JSON.stringify({ audioDir: './yok' }));
    const empty = await (await get('/api/projects/no-audio/music')).json();
    assert.equal(empty.ready, false);
    assert.deepEqual(empty.audioFiles, []);
  });

  test('proje dışındaki audioDir: dosyalar listelenir ama sunulmaz', async () => {
    const shared = join(videosDir, 'plan', 'audio');
    await writeProject('outside-audio', {
      project: { audioDir: shared, music: { tracks: [track(1, 'completed', '01 Rain.mp3')] } },
    });
    const body = await (await get('/api/projects/outside-audio/music')).json();
    assert.equal(body.audioDirInsideProject, false);
    assert.equal(body.tracks[0].missing, false);
    assert.equal(body.tracks[0].audio.previewUrl, null);
    assert.equal(body.tracks[0].audio.duration, null);
    assert.equal((await get('/api/projects/outside-audio/assets/audio/01%20Rain.mp3')).status, 404);
  });

  test('bozuk project.json, geçersiz ve olmayan proje', async () => {
    const dir = await writeProject('broken-json', { audio: ['a.mp3'] });
    await writeFile(join(dir, 'project.json'), '{ bozuk');
    const body = await (await get('/api/projects/broken-json/music')).json();
    assert.equal(body.mode, 'files');
    assert.equal(body.summary.audioFileCount, 1);

    assert.equal((await get('/api/projects/..%2Fplan/music')).status, 400);
    assert.equal((await get('/api/projects/nope/music')).status, 404);
    assert.equal((await fetch(`${url}/api/projects/plan/music`, { method: 'DELETE' })).status, 405);
  });
});
