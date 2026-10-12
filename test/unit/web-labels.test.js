/**
 * GET/PUT /api/projects/:id/labels — video üstü etiketlerin konum kaydı.
 *
 * Neden var: etiket konumu kullanıcı arayüzünde değişir, ama Pomodoro zamanlaması
 * ve durumu (`pomodoro` bloğu) bu uçtan ASLA değişmemeli. Buradaki testler hem
 * konumların project.json'a doğru yazıldığını hem de geri kalan konfige
 * dokunulmadığını doğrular.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { buildTimeline, normalizePomodoroSelection } from '../../core/pomodoro-plan.js';
import { ApiError, getLabels, updateLabels } from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';

let base;
let videosDir;
let server;
let url;

const options = () => ({ videosDir });

async function writeProject(name, project = {}) {
  const dir = join(videosDir, name);
  await mkdir(join(dir, 'audio'), { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    clip: './videolar/in.mp4', audioDir: './audio', video: { cropBottom: 150 }, ...project,
  }, null, 2));
  return dir;
}

const readProjectJson = async (name) =>
  JSON.parse(await readFile(join(videosDir, name, 'project.json'), 'utf8'));

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-labels-'));
  videosDir = join(base, 'videolar');
  await mkdir(videosDir);

  server = createWebServer({
    projectApi: {
      getLabels: (id) => getLabels(id, options()),
      updateLabels: (id, body) => updateLabels(id, body, options()),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await rm(base, { recursive: true, force: true });
});

describe('GET /api/projects/:id/labels', () => {
  test('etiketsiz (eski) proje: boş liste, varsayılan 16:9, Pomodoro kapalı', async () => {
    await writeProject('legacy');
    const res = await getLabels('legacy', options());
    assert.deepEqual(res.labels, []);
    assert.deepEqual(res.problems, []);
    assert.equal(res.aspect, '16:9');
    assert.deepEqual(res.pomodoro, { enabled: false, totalSeconds: 0, sessions: [] });
  });

  test('kayıtlı etiketler normalleştirilmiş döner (varsayılanlar doldurulur)', async () => {
    await writeProject('saved', { labels: [{ id: 'a', text: 'Merhaba', x: 0.2, y: 0.3 }] });
    const res = await getLabels('saved', options());
    assert.equal(res.labels.length, 1);
    assert.equal(res.labels[0].x, 0.2);
    assert.equal(res.labels[0].size, 0.05);
    assert.equal(res.labels[0].color, '#ffffff');
  });

  test('Pomodoro açıksa oturumlar timeline ile BİREBİR aynı (yalnızca okunur)', async () => {
    const pomodoro = { enabled: true, preset: '50/10', rounds: 4 };
    await writeProject('pomo', { pomodoro });
    const res = await getLabels('pomo', options());
    const { plan } = normalizePomodoroSelection(pomodoro);
    assert.equal(res.pomodoro.enabled, true);
    assert.deepEqual(res.pomodoro.sessions, buildTimeline(plan).sessions);
    assert.equal(res.pomodoro.totalSeconds, 240 * 60);
  });

  test('bozuk kayıt gizlenmez: problems döner, geçerli etiketler kalır', async () => {
    await writeProject('broken', { labels: [{ id: 'a', text: 'iyi' }, { id: 'b', text: '' }] });
    const res = await getLabels('broken', options());
    assert.deepEqual(res.labels.map((l) => l.id), ['a']);
    assert.equal(res.problems.length, 1);
  });
});

describe('PUT /api/projects/:id/labels', () => {
  test('konumlar project.json\'a yazılır, geri okununca aynı', async () => {
    await writeProject('write');
    const res = await updateLabels('write', {
      labels: [{ id: 'etiket-01', text: 'Selam', x: 0.123456, y: 0.9, size: 0.08, color: '#FF0000' }],
    }, options());

    const json = await readProjectJson('write');
    assert.deepEqual(json.labels, [
      { id: 'etiket-01', text: 'Selam', x: 0.1235, y: 0.9, size: 0.08, color: '#ff0000' },
    ]);
    assert.equal(res.labels[0].x, 0.1235);
    assert.equal((await getLabels('write', options())).labels[0].text, 'Selam');
  });

  test('etiket yazmak başka konfige dokunmaz — özellikle `pomodoro` bloğuna', async () => {
    const pomodoro = { enabled: true, preset: '30/10', rounds: 6, trimExcess: true, countdownBeep: false };
    await writeProject('untouched', { pomodoro, ambient: ['./rain.mp3'], order: ['b', 'a'] });
    const before = await readProjectJson('untouched');

    await updateLabels('untouched', {
      labels: [
        { id: 'a', text: 'Merhaba', x: 0.1, y: 0.1 },
        { id: 's', kind: 'pomodoro-status', x: 0.8, y: 0.2 },
        { id: 'c', kind: 'pomodoro-countdown', x: 0.8, y: 0.1 },
      ],
    }, options());

    const after = await readProjectJson('untouched');
    const { labels, ...rest } = after;
    const { labels: _none, ...beforeRest } = before;
    assert.equal(labels.length, 3);
    assert.deepEqual(rest, beforeRest, 'labels dışındaki her anahtar aynı kalmalı');
    assert.deepEqual(after.pomodoro, pomodoro);
  });

  test('boş liste anahtarı siler: sistem etiketsiz projedeki gibi çalışır', async () => {
    await writeProject('clear', { labels: [{ id: 'a', text: 'x' }] });
    await updateLabels('clear', { labels: [] }, options());
    assert.equal(Object.hasOwn(await readProjectJson('clear'), 'labels'), false);
  });

  test('geçersiz etiket 422: hiçbir şey yazılmaz', async () => {
    await writeProject('invalid', { labels: [{ id: 'a', text: 'eski' }] });
    await assert.rejects(
      updateLabels('invalid', { labels: [{ id: 'a', text: 'yeni' }, { id: 'b', text: '   ' }] }, options()),
      (error) => error instanceof ApiError && error.status === 422,
    );
    assert.equal((await readProjectJson('invalid')).labels[0].text, 'eski');
  });

  test('gövdede labels yoksa 400', async () => {
    await writeProject('nobody');
    await assert.rejects(
      updateLabels('nobody', {}, options()),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('HTTP: PUT sonra GET aynı etiketleri verir', async () => {
    await writeProject('http');
    const put = await fetch(`${url}/api/projects/http/labels`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: [{ id: 'a', text: 'Merhaba', x: 0.4, y: 0.6 }] }),
    });
    assert.equal(put.status, 200);
    const get = await (await fetch(`${url}/api/projects/http/labels`)).json();
    assert.equal(get.labels[0].x, 0.4);
    assert.equal(get.labels[0].y, 0.6);
  });
});
