/**
 * Web müzik stili akışları: /api/library, /api/styles CRUD (stil = ad +
 * müzik profili + isteğe bağlı ambient önerisi) ve GET /api/projects/:id/master.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  createLibraryStyle, deleteLibraryStyle, getAsset, getLibrary, getMaster, getStyle, updateLibraryStyle,
} from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';

const MUSIC = { genre: 'lofi hip hop', instruments: ['Rhodes', 'brushed drums'], exclude: ['vocals'] };

let base;
let videosDir;
let stylesDir;
let ambientDir;
let server;
let url;

function send(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return fetch(`${url}${path}`, init);
}

const readStyle = async (name) => JSON.parse(await readFile(join(stylesDir, `${name}.json`), 'utf8'));

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-styles-'));
  videosDir = join(base, 'videolar');
  stylesDir = join(base, 'styles');
  ambientDir = join(base, 'ambient');
  await mkdir(videosDir);
  await mkdir(stylesDir);
  await mkdir(ambientDir);
  await writeFile(join(ambientDir, 'heavyRain.mp3'), '');
  // Eski görsel alanlı stil: yüklenir, alanları korunur.
  await writeFile(join(stylesDir, 'eski.json'), JSON.stringify({
    name: 'eski', styleBlock: { medium: 'x' }, motionHints: ['y'], suggestedAmbient: 'heavyRain',
  }));
  await writeFile(join(stylesDir, 'bozuk.json'), JSON.stringify({ name: 'baska' }));

  server = createWebServer({
    projectApi: {
      getLibrary: () => getLibrary({ stylesDir, ambientDir }),
      createLibraryStyle: (body) => createLibraryStyle(body, { stylesDir, ambientDir }),
      getStyle: (id) => getStyle(id, { stylesDir, ambientDir }),
      updateLibraryStyle: (id, body) => updateLibraryStyle(id, body, { stylesDir, ambientDir }),
      deleteLibraryStyle: (id) => deleteLibraryStyle(id, { stylesDir }),
      getMaster: (id) => getMaster(id, { videosDir }),
      getAsset: (id, type, file) => getAsset(id, type, file, { videosDir }),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(base, { recursive: true, force: true });
});

describe('GET /api/library', () => {
  test('stiller müzik profili durumuyla; geçersiz stil problemleriyle; ambient adları', async () => {
    const body = await (await send('GET', '/api/library')).json();
    assert.deepEqual(body.ambients, [{ name: 'heavyRain' }]);
    const eski = body.styles.find((s) => s.name === 'eski');
    assert.deepEqual(eski, {
      name: 'eski', valid: true, music: null, hasMusicProfile: false, suggestedAmbient: 'heavyRain', warnings: [],
    });
    const bozuk = body.styles.find((s) => s.name === 'bozuk');
    assert.equal(bozuk.valid, false);
    assert.match(bozuk.problems[0], /dosya adıyla aynı/);
    assert.ok(!body.styles.some((s) => s.name === 'custom-generated'));
  });
});

describe('/api/styles — müzik stili CRUD', () => {
  test('oluştur, oku, güncelle (yeniden adlandır), sil', async () => {
    const created = await send('POST', '/api/styles', { name: 'gece-lofi', music: MUSIC, suggestedAmbient: 'heavyRain' });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).style.hasMusicProfile, true);
    assert.deepEqual(await readStyle('gece-lofi'), { name: 'gece-lofi', music: MUSIC, suggestedAmbient: 'heavyRain' });

    assert.equal((await send('POST', '/api/styles', { name: 'gece-lofi' })).status, 409);
    assert.equal((await (await send('GET', '/api/styles/gece-lofi')).json()).music.genre, 'lofi hip hop');

    const renamed = await send('PUT', '/api/styles/gece-lofi', { name: 'sabah-lofi', music: { genre: 'jazzhop' }, suggestedAmbient: '' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await readStyle('sabah-lofi'), { name: 'sabah-lofi', music: { genre: 'jazzhop' } });
    assert.equal((await send('GET', '/api/styles/gece-lofi')).status, 404);

    assert.equal((await send('DELETE', '/api/styles/sabah-lofi')).status, 200);
    assert.equal((await send('GET', '/api/styles/sabah-lofi')).status, 404);
  });

  test('güncelleme eski görsel alanları korur; music: null profili siler', async () => {
    await send('PUT', '/api/styles/eski', { music: MUSIC });
    assert.deepEqual((await readStyle('eski')).styleBlock, { medium: 'x' });
    assert.deepEqual((await readStyle('eski')).music, MUSIC);
    await send('PUT', '/api/styles/eski', { music: null });
    assert.ok(!Object.hasOwn(await readStyle('eski'), 'music'));
  });

  test('doğrulama: ad, bilinmeyen alan, geçersiz profil', async () => {
    assert.equal((await send('POST', '/api/styles', { name: 'Kötü Ad' })).status, 400);
    assert.equal((await send('POST', '/api/styles', { name: 'x', styleBlock: {} })).status, 400);
    const bad = await send('POST', '/api/styles', { name: 'x', music: { genre: 3 } });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).problems[0], /music.genre/);
    assert.equal((await send('PUT', '/api/styles/eski', { name: 'bozuk' })).status, 409);
  });
});

describe('GET /api/projects/:id/master — elle üretilen görsel', () => {
  const writeProject = async (name) => {
    const dir = join(videosDir, name);
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await writeFile(join(dir, 'project.json'), JSON.stringify({ clip: '', audioDir: './audio', video: { cropBottom: 0 } }));
    return dir;
  };

  test('master yokken beklenen dosya; konunca hazır ve önizlenebilir; prompt yok', async () => {
    const dir = await writeProject('p1');
    let info = await (await send('GET', '/api/projects/p1/master')).json();
    assert.equal(info.ready, false);
    assert.equal(info.expectedName, 'MASTER.png');
    assert.ok(!('prompt' in info));
    await writeFile(join(dir, 'resimler', 'MASTER.jfif'), 'img');
    info = await (await send('GET', '/api/projects/p1/master')).json();
    assert.equal(info.ready, true);
    assert.equal(info.previewUrl, '/api/projects/p1/assets/master/MASTER.jfif');
    assert.equal((await send('GET', info.previewUrl)).headers.get('content-type'), 'image/jpeg');
  });

  test('proje dışına bağlanan resimler/ içindeki MASTER hazır sayılmaz', async () => {
    const dir = join(videosDir, 'p2');
    await mkdir(dir);
    await writeFile(join(dir, 'project.json'), JSON.stringify({ clip: '', audioDir: './audio' }));
    const outside = join(base, 'disari');
    await mkdir(outside);
    await writeFile(join(outside, 'MASTER.png'), 'x');
    await symlink(outside, join(dir, 'resimler'), 'junction');
    assert.equal((await (await send('GET', '/api/projects/p2/master')).json()).ready, false);
  });
});
