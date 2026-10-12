import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  assignAlbumToProject,
  createAlbum,
  deleteAlbum,
  deleteAlbumTrack,
  getMusicAsset,
  getMusicLibrary,
  openMusicFolder,
  uploadAlbumTrack,
} from '../../server/music-library-api.js';
import { createWebServer } from '../../server/web-server.js';

async function createLibraryFixture() {
  const baseDir = await mkdtemp(join(tmpdir(), 'lofi-music-lib-'));
  const musicDir = join(baseDir, 'music_library');
  const videosDir = join(baseDir, 'videos');
  await mkdir(musicDir, { recursive: true });
  await mkdir(videosDir, { recursive: true });

  const projectName = 'lofi-tokyo';
  const projectDir = join(videosDir, projectName);
  await mkdir(join(projectDir, 'audio'), { recursive: true });
  await writeFile(join(projectDir, 'project.json'), JSON.stringify({
    clip: '',
    audioDir: './audio',
    music: {
      totalTracks: 2,
      completedCount: 0,
      status: 'pending',
      tracks: [
        { number: 1, title: 'Track 1', status: 'pending' },
        { number: 2, title: 'Track 2', status: 'pending' },
      ],
    },
  }, null, 2));

  return {
    baseDir,
    musicDir,
    videosDir,
    projectName,
    projectDir,
    cleanup: () => rm(baseDir, { recursive: true, force: true }),
  };
}

async function startServer(api) {
  const server = createWebServer({ projectApi: api });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    }),
  };
}

describe('music-library API', () => {
  test('createAlbum and getMusicLibrary list albums and statistics', async () => {
    const fixture = await createLibraryFixture();
    try {
      const album = await createAlbum({ name: 'Midnight Beats' }, { musicDir: fixture.musicDir });
      assert.equal(album.id, 'Midnight-Beats');
      assert.equal(album.name, 'Midnight-Beats');

      // Add a dummy mp3 file
      await writeFile(join(fixture.musicDir, 'Midnight-Beats', '01-track.mp3'), Buffer.from('fake mp3'));

      const library = await getMusicLibrary({
        musicDir: fixture.musicDir,
        videosDir: fixture.videosDir,
        probeFn: async () => ({ duration: 120.5 }),
      });

      assert.equal(library.albums.length, 1);
      assert.equal(library.albums[0].id, 'Midnight-Beats');
      assert.equal(library.albums[0].trackCount, 1);
      assert.equal(library.albums[0].tracks[0].file, '01-track.mp3');
      assert.equal(library.albums[0].tracks[0].duration, 120.5);
      assert.equal(library.albums[0].tracks[0].durationFormatted, '2:01');
      assert.equal(library.projects.length, 1);
      assert.equal(library.projects[0].id, fixture.projectName);
    } finally {
      await fixture.cleanup();
    }
  });

  test('uploadAlbumTrack, deleteAlbumTrack, deleteAlbum', async () => {
    const fixture = await createLibraryFixture();
    try {
      await createAlbum({ name: 'Chill Vibes' }, { musicDir: fixture.musicDir });

      const fakeAudioBase64 = Buffer.from('RIFF....WAVEfmt ').toString('base64');
      const uploaded = await uploadAlbumTrack('Chill-Vibes', {
        name: 'sample.wav',
        data: fakeAudioBase64,
      }, { musicDir: fixture.musicDir });

      assert.equal(uploaded.ok, true);
      assert.equal(uploaded.file, 'sample.wav');

      const asset = await getMusicAsset('Chill-Vibes', 'sample.wav', { musicDir: fixture.musicDir });
      assert.equal(asset.contentType, 'audio/wav');
      assert.ok(asset.size > 0);

      const deletedTrack = await deleteAlbumTrack('Chill-Vibes', 'sample.wav', { musicDir: fixture.musicDir });
      assert.equal(deletedTrack.ok, true);

      const deletedAlbum = await deleteAlbum('Chill-Vibes', { musicDir: fixture.musicDir });
      assert.equal(deletedAlbum.ok, true);
    } finally {
      await fixture.cleanup();
    }
  });

  test('assignAlbumToProject copies tracks and updates project.json', async () => {
    const fixture = await createLibraryFixture();
    try {
      await createAlbum({ name: 'Synth-Wave' }, { musicDir: fixture.musicDir });
      // Albüme önce b, sonra a eklendi: kopyalama ve kayıt bu sırayla.
      await writeFile(join(fixture.musicDir, 'Synth-Wave', 'track-b.mp3'), Buffer.from('audio b'));
      await new Promise((resolveWait) => setTimeout(resolveWait, 30));
      await writeFile(join(fixture.musicDir, 'Synth-Wave', 'track-a.mp3'), Buffer.from('audio a'));

      const assignRes = await assignAlbumToProject({
        albumId: 'Synth-Wave',
        projectId: fixture.projectName,
      }, {
        musicDir: fixture.musicDir,
        videosDir: fixture.videosDir,
      });

      assert.equal(assignRes.ok, true);
      assert.equal(assignRes.copiedCount, 2);
      assert.deepEqual(assignRes.copiedFiles, ['track-b.mp3', 'track-a.mp3']);
      const project = JSON.parse(await readFile(join(fixture.videosDir, fixture.projectName, 'project.json'), 'utf8'));
      assert.deepEqual(project.workflow.audioAdded, ['track-b.mp3', 'track-a.mp3']);
    } finally {
      await fixture.cleanup();
    }
  });

  test('HTTP endpoints for music library work as expected', async () => {
    const fixture = await createLibraryFixture();
    const server = await startServer({
      getMusicLibrary: () => getMusicLibrary({ musicDir: fixture.musicDir, videosDir: fixture.videosDir }),
      createAlbum: (body) => createAlbum(body, { musicDir: fixture.musicDir }),
      deleteAlbum: (id) => deleteAlbum(id, { musicDir: fixture.musicDir }),
      deleteAlbumTrack: (albumId, filename) => deleteAlbumTrack(albumId, filename, { musicDir: fixture.musicDir }),
      uploadAlbumTrack: (albumId, body) => uploadAlbumTrack(albumId, body, { musicDir: fixture.musicDir }),
      openMusicFolder: (body) => openMusicFolder(body, { musicDir: fixture.musicDir, openFn: () => true }),
      assignAlbumToProject: (body) => assignAlbumToProject(body, { musicDir: fixture.musicDir, videosDir: fixture.videosDir }),
      getMusicAsset: (albumId, filename) => getMusicAsset(albumId, filename, { musicDir: fixture.musicDir }),
    });

    try {
      // Create album via HTTP
      const postRes = await fetch(`${server.url}/api/music-library/albums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Future Funk' }),
      });
      assert.equal(postRes.status, 201);
      const album = await postRes.json();
      assert.equal(album.id, 'Future-Funk');

      // Get music library
      const getRes = await fetch(`${server.url}/api/music-library`);
      assert.equal(getRes.status, 200);
      const lib = await getRes.json();
      assert.equal(lib.albums.length, 1);
      assert.equal(lib.albums[0].id, 'Future-Funk');
    } finally {
      await server.close();
      await fixture.cleanup();
    }
  });
});
