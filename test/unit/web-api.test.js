import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

import { createBuildJobs } from '../../server/build-jobs.js';
import {
  completeMusic, createProject, describeReadiness, getAsset, getBuild, getLibrary, getProject, getProjects, listClips,
  getProjectPrompts, selectClip, startBuild, updateCrop, updateTrackOrder, updateWorkflow, uploadProjectAudio,
  uploadProjectClip, uploadProjectImage,
} from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';
import { isMusicCompleted } from '../../prep/project-status.js';

// Müzik planı Gemini'ye gitmesin: deterministik yedek plan kullanılır.
delete process.env.GEMINI_API_KEY;

const STYLES_DIR = fileURLToPath(new URL('../../styles/', import.meta.url));

let base;
let videosDir;
let ambientDir;
let server;
let url;
let spawned;

/** Sahte build.js süreci: testte stdout yazıp kapatılır. */
function fakeSpawn(command, args, options) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  spawned.push({ command, args, options, child });
  return child;
}

/** Sahte ffprobe: adı "broken" içeren klip ölçülemez, "audio-only" video akışsız. */
async function fakeProbe(path) {
  if (path.includes('broken')) throw new Error('Dosyada hiç akış yok, bozuk olabilir');
  if (path.includes('audio-only')) return { hasVideo: false };
  return {
    path, duration: 6, width: 1920, height: 1080, fps: 24, videoCodec: 'h264', hasVideo: true, hasAudio: false,
    size: 10, bitrate: 1, formatName: 'mp4', audioCodec: null, sampleRate: null, channels: null, audioBitrate: null,
  };
}

async function writeProjectFolder(name, { project = {}, files = [] } = {}) {
  const dir = join(videosDir, name);
  for (const sub of ['audio', 'resimler', 'videolar', 'references']) {
    await mkdir(join(dir, sub), { recursive: true });
  }
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    clip: '',
    audioDir: './audio',
    video: { cropBottom: 150, aspect: '16:9' },
    output: { dir: './out' },
    style: 'cozy-realistic',
    ...project,
  }, null, 2));
  for (const file of files) {
    await mkdir(join(dir, file, '..'), { recursive: true });
    await writeFile(join(dir, file), '');
  }
  return dir;
}

function send(method, path, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] ??= 'application/json';
  }
  return fetch(`${url}${path}`, init);
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-api-actions-'));
  videosDir = join(base, 'videolar');
  ambientDir = join(base, 'ambient');
  await mkdir(videosDir);
  await mkdir(ambientDir);
  for (const file of ['gentleRain.mp3', 'campfire.mp3']) await writeFile(join(ambientDir, file), '');

  // Hazır: master + klip + ses → build. Müzikte: master var, klip ve ses yok → audio.
  await writeProjectFolder('ready', {
    project: { clip: './videolar/in.mp4' },
    files: ['resimler/MASTER.png', 'videolar/in.mp4', 'audio/01.mp3'],
  });
  await writeProjectFolder('music-step', { files: ['resimler/MASTER.png', 'videolar/other.mp4'] });
  await writeProjectFolder('done', {
    project: { clip: './videolar/in.mp4' },
    files: ['resimler/MASTER.png', 'videolar/in.mp4', 'audio/01.mp3', 'out/final_ambient.mp4'],
  });

  spawned = [];
  const buildJobs = createBuildJobs({ spawnFn: fakeSpawn, repoRoot: 'X:\\repo', now: () => 0 });
  const stylesDir = STYLES_DIR;
  const options = { videosDir };
  server = createWebServer({
    projectApi: {
      getProjects: () => getProjects(options),
      getProject: (id) => getProject(id, options),
      createProject: (body) => createProject(body, { videosDir, ambientDir, stylesDir }),
      getLibrary: () => getLibrary({ stylesDir, ambientDir }),
      selectClip: (id, body) => selectClip(id, body, options),
      completeMusic: (id, body) => completeMusic(id, body, options),
      startBuild: (id, body) => startBuild(id, body, { videosDir, buildJobs }),
      getBuild: (id) => getBuild(id, { videosDir, buildJobs }),
      getAsset: (id, type, file) => getAsset(id, type, file, options),
      updateCrop: (id, body) => updateCrop(id, body, options),
      listClips: (id) => listClips(id, { videosDir, probeFn: fakeProbe }),
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

describe('readiness — workflow sırasından bağımsız kanıt', () => {
  test('müzik adımındaki projede klip hazır sayılmaz; montaj eksikleri listelenir', async () => {
    const project = await getProject('music-step', { videosDir });
    assert.equal(project.step.id, 'clip');
    assert.equal(project.readiness.master.ready, true);
    assert.deepEqual(project.readiness.clip, { ready: false, selected: null, availableCount: 1 });
    assert.equal(project.readiness.music.ready, false);
    assert.deepEqual(project.readiness.build, { ready: false, missing: ['clip', 'music'] });
    assert.equal(project.readiness.output.exists, false);
  });

  test('hazır projede eksik yok', async () => {
    const project = await getProject('ready', { videosDir });
    assert.equal(project.step.id, 'build');
    assert.deepEqual(project.readiness.build, { ready: true, missing: [] });
    assert.equal(project.readiness.clip.selected, './videolar/in.mp4');
  });

  test('bozuk project.json montaj eksiği olarak raporlanır', () => {
    const readiness = describeReadiness({
      projectJson: { ok: false, data: null, error: 'x' },
      style: '-', styleBlockExists: false, references: [], master: null,
      clip: { value: '', path: null, exists: false }, clips: [], audioCount: 0,
      output: { path: 'X:\\o.mp4', exists: false },
    });
    assert.deepEqual(readiness.build.missing, ['projectJson', 'clip', 'music']);
    assert.equal(readiness.style.name, null);
  });

  test('custom-generated stil, STYLE_BLOCK yokken hazır değil', () => {
    const readiness = describeReadiness({
      projectJson: { ok: true, data: {}, error: null },
      style: 'custom-generated', styleBlockExists: false, references: ['a.jpg'], master: null,
      clip: { value: '', path: null, exists: false }, clips: [], audioCount: 0,
      output: { path: 'X:\\o.mp4', exists: false },
    });
    assert.deepEqual(readiness.style, {
      ready: false, name: 'custom-generated', styleBlockExists: false, referenceCount: 1,
    });
  });

  test('isMusicCompleted: parça planı varsa plan durumu, yoksa ses dosyası', () => {
    const tracks = [{ status: 'completed' }, { status: 'pending' }];
    const make = (music, audioCount) => ({ projectJson: { ok: true, data: { music } }, audioCount });
    assert.equal(isMusicCompleted(make({ tracks }, 5)), false);
    assert.equal(isMusicCompleted(make({ tracks, status: 'completed_by_user' }, 0)), true);
    assert.equal(isMusicCompleted(make(undefined, 1)), true);
    assert.equal(isMusicCompleted(make(undefined, 0)), false);
  });

  test('GET /api/projects/:id readiness alanını döndürür, eski alanlar korunur', async () => {
    const response = await send('GET', '/api/projects/music-step');
    assert.equal(response.status, 200);
    const project = await response.json();
    assert.equal(project.id, 'music-step');
    assert.equal(project.step.id, 'clip');
    // Web akışı canonical sırada: klip (Video) müzikten önce.
    assert.equal(project.workflow.current, 'angles');
    assert.equal(project.projectJson.ok, true);
    assert.equal(project.readiness.clip.ready, false);
  });
});

describe('GET /api/library', () => {
  test('stiller (custom-generated önce) ve ambient adları', async () => {
    const response = await send('GET', '/api/library');
    assert.equal(response.status, 200);
    const library = await response.json();
    assert.equal(library.styles[0].name, 'custom-generated');
    assert.equal(library.styles[0].kind, 'custom');
    const watercolor = library.styles.find((style) => style.name === 'watercolor');
    assert.equal(watercolor.valid, true);
    assert.equal(typeof watercolor.suggestedAmbient, 'string');
    assert.ok(Array.isArray(watercolor.styleBlock.palette));
    assert.deepEqual(library.ambients, [{ name: 'campfire' }, { name: 'gentleRain' }]);
    assert.equal(library.ambientError, null);
  });

  test('ambient klasörü yoksa boş liste ve hata mesajı', async () => {
    const library = await getLibrary({ ambientDir: join(base, 'no-such-dir') });
    assert.deepEqual(library.ambients, []);
    assert.match(library.ambientError, /ambient klasörü okunamadı/);
  });

  test('geçersiz stil dosyası listede problemleriyle döner', async () => {
    const stylesDir = join(base, 'styles-invalid');
    await mkdir(stylesDir);
    await writeFile(join(stylesDir, 'broken.json'), '{ "name": "broken" }');
    const library = await getLibrary({ stylesDir, ambientDir });
    const broken = library.styles.find((style) => style.name === 'broken');
    assert.equal(broken.valid, false);
    assert.ok(broken.problems.length > 0);
  });
});

describe('POST /api/projects', () => {
  test('geçerli istek projeyi mevcut iskeletle oluşturur', async () => {
    const response = await send('POST', '/api/projects', {
      body: { name: 'new album', style: 'watercolor', ambient: ['gentleRain'], concept: 'Rainy night', totalTracks: 3 },
    });
    assert.equal(response.status, 201);
    const { project, warnings } = await response.json();
    assert.ok(Array.isArray(warnings));
    assert.equal(project.id, 'new album');
    assert.equal(project.step.id, 'faz1');
    assert.equal(project.style, 'watercolor');

    const dir = join(videosDir, 'new album');
    for (const sub of ['audio', 'resimler', 'videolar', 'references']) {
      assert.ok((await stat(join(dir, sub))).isDirectory());
    }
    const json = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    assert.equal(json.style, 'watercolor');
    assert.equal(json.music.concept, 'Rainy night');
    assert.equal(json.music.tracks.length, 3);
    assert.equal(json.ambient, join(ambientDir, 'gentleRain.mp3'));
    assert.ok((await stat(join(dir, 'prompts.md'))).isFile());
    assert.ok((await stat(join(dir, 'STYLE_BLOCK.txt'))).isFile());
  });

  test('aynı isim ikinci kez → 409, klasöre dokunulmaz', async () => {
    const response = await send('POST', '/api/projects', { body: { name: 'ready', style: 'watercolor' } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Project already exists' });
    const json = JSON.parse(await readFile(join(videosDir, 'ready', 'project.json'), 'utf8'));
    assert.equal(json.style, 'cozy-realistic');
  });

  test('var olan isimde müzik planı hiç üretilmez (runNewVideo çağrılmaz)', async () => {
    let called = false;
    const runNewVideoFn = async () => { called = true; };
    await assert.rejects(
      createProject({ name: 'ready', style: 'watercolor' }, { videosDir, ambientDir, runNewVideoFn }),
      { name: 'ApiError', status: 409 },
    );
    assert.equal(called, false);
  });

  test('domain doğrulaması 422 ve problemler: geçersiz isim, bilinmeyen stil/ambient', async () => {
    const response = await send('POST', '/api/projects', {
      body: { name: 'bad:name', style: 'no-such-style', ambient: ['thunder'] },
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, 'Project could not be created');
    assert.ok(body.problems.some((p) => p.includes('geçersiz karakter')));
    assert.ok(body.problems.some((p) => p.includes('bilinmeyen stil')));
    assert.ok(body.problems.some((p) => p.includes('bilinmeyen ambient "thunder"')));
  });

  test('yol kaçışı içeren isim 422, videolar kökü dışına yazılmaz', async () => {
    for (const name of ['../escape', '..', 'a\\b']) {
      const response = await send('POST', '/api/projects', { body: { name, style: 'watercolor' } });
      assert.equal(response.status, 422, name);
    }
    await assert.rejects(stat(join(base, 'escape')), { code: 'ENOENT' });
  });

  test('bozuk istekler 400', async () => {
    const cases = [
      [undefined, 'Request body must be a JSON object'],
      [[], 'Request body must be a JSON object'],
      [{ style: 'watercolor' }, 'Missing field: name'],
      [{ name: 'x', style: 'watercolor', extra: 1 }, 'Unknown field: extra'],
      [{ name: 5, style: 'watercolor' }, 'Field name must be a string'],
      [{ name: 'x', style: 'watercolor', ambient: 'gentleRain' }, 'Field ambient must be an array'],
      [{ name: 'x', style: 'watercolor', ambient: [''] }, 'ambient must be an array of names'],
      [{ name: 'x', style: 'watercolor', totalTracks: 0 }, 'totalTracks must be an integer between 1 and 50'],
      [{ name: 'x', style: 'watercolor', totalTracks: 2.5 }, 'totalTracks must be an integer between 1 and 50'],
      [{ name: 'x', style: 'watercolor', concept: 'c'.repeat(301) }, 'concept must be at most 300 characters'],
    ];
    for (const [body, error] of cases) {
      const response = body === undefined
        ? await send('POST', '/api/projects', { headers: { 'content-type': 'application/json' } })
        : await send('POST', '/api/projects', { body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.deepEqual(await response.json(), { error });
    }
    await assert.rejects(stat(join(videosDir, 'x')), { code: 'ENOENT' });
  });

  test('geçersiz JSON 400, JSON olmayan içerik 415, yabancı origin 403, büyük gövde 413', async () => {
    const invalid = await send('POST', '/api/projects', { body: '{nope', headers: { 'content-type': 'application/json' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'Request body must be valid JSON' });

    const plain = await send('POST', '/api/projects', {
      body: JSON.stringify({ name: 'plain', style: 'watercolor' }),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.status, 415);

    const foreign = await send('POST', '/api/projects', {
      body: { name: 'foreign', style: 'watercolor' },
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(await foreign.json(), { error: 'Forbidden origin' });

    const local = await send('POST', '/api/projects', {
      body: { name: 'from-vite', style: 'watercolor' },
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(local.status, 201);

    const huge = await send('POST', '/api/projects', { body: { name: 'x', style: 'watercolor', concept: 'c'.repeat(70000) } });
    assert.equal(huge.status, 413);

    for (const name of ['plain', 'foreign']) {
      await assert.rejects(stat(join(videosDir, name)), { code: 'ENOENT' });
    }
  });
});

describe('PUT /api/projects/:id/clip', () => {
  test('videolar klasöründeki klip seçilir, project.json güncellenir', async () => {
    const response = await send('PUT', '/api/projects/music-step/clip', { body: { file: 'other.mp4' } });
    assert.equal(response.status, 200);
    const project = await response.json();
    assert.equal(project.clip.value, './videolar/other.mp4');
    assert.equal(project.readiness.clip.ready, true);
    assert.equal(project.step.id, 'audio');
    const json = JSON.parse(await readFile(join(videosDir, 'music-step', 'project.json'), 'utf8'));
    assert.equal(json.clip, './videolar/other.mp4');
    assert.equal(json.style, 'cozy-realistic');
  });

  test('klasörde olmayan ya da dışarıyı gösteren dosya 422', async () => {
    for (const file of ['missing.mp4', '../project.json', '..\\..\\ready\\videolar\\in.mp4', 'C:\\Windows\\win.ini']) {
      const response = await send('PUT', '/api/projects/ready/clip', { body: { file } });
      assert.equal(response.status, 422, file);
      const body = await response.json();
      assert.equal(body.error, 'Clip not found in the project videolar folder');
      assert.deepEqual(body.available, ['in.mp4']);
    }
  });

  test('bozuk gövde 400, olmayan proje 404, kaçış denemesi 400', async () => {
    assert.equal((await send('PUT', '/api/projects/ready/clip', { body: {} })).status, 400);
    assert.equal((await send('PUT', '/api/projects/ready/clip', { body: { file: 1 } })).status, 400);
    assert.equal((await send('PUT', '/api/projects/nope/clip', { body: { file: 'in.mp4' } })).status, 404);
    const traversal = await send('PUT', '/api/projects/..%2F..%2Fx/clip', { body: { file: 'in.mp4' } });
    assert.equal(traversal.status, 400);
    assert.deepEqual(await traversal.json(), { error: 'Invalid project id' });
    assert.equal((await send('PUT', '/api/projects/..%5Cready/clip', { body: { file: 'in.mp4' } })).status, 400);
  });

  test('bozuk project.json 409', async () => {
    await writeProjectFolder('broken-json', { files: ['videolar/in.mp4'] });
    await writeFile(join(videosDir, 'broken-json', 'project.json'), '{ nope');
    const response = await send('PUT', '/api/projects/broken-json/clip', { body: { file: 'in.mp4' } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'project.json is invalid');
  });
});

describe('POST /api/projects/:id/music/complete', () => {
  const plan = (statuses) => ({
    concept: 'c',
    totalTracks: statuses.length,
    completedCount: 0,
    status: 'in_progress',
    tracks: statuses.map((status, i) => ({ number: i + 1, title: `T${i + 1}`, prompt: 'p', status, file: null })),
  });
  const postEmpty = (path) => send('POST', path, { headers: { 'content-type': 'application/json' } });
  const readJson = (name) => readFile(join(videosDir, name, 'project.json'), 'utf8');

  test('planlı projede ses dosyası varken müzik kullanıcı tarafından tamamlanır', async () => {
    await writeProjectFolder('music-plan', {
      project: { music: plan(['completed', 'pending', 'pending']), ambient: 'X:\\ambient\\rain.mp3' },
      files: ['resimler/MASTER.png', 'audio/01.mp3'],
    });
    const before = await getProject('music-plan', { videosDir });
    assert.equal(before.step.id, 'faz3');
    assert.equal(before.workflow.current, 'angles');

    const response = await postEmpty('/api/projects/music-plan/music/complete');
    assert.equal(response.status, 200);
    const project = await response.json();
    assert.equal(project.readiness.music.ready, true);
    assert.equal(project.readiness.music.status, 'completed_by_user');
    assert.equal(project.step.id, 'faz3');
    assert.deepEqual(project.readiness.build.missing, ['clip']);

    const json = JSON.parse(await readJson('music-plan'));
    assert.equal(json.music.status, 'completed_by_user');
    assert.equal(json.music.completedCount, 1);
    assert.deepEqual(json.music.tracks.map((t) => t.status), ['completed', 'pending', 'pending']);
    assert.equal(json.ambient, 'X:\\ambient\\rain.mp3');
    assert.equal(json.style, 'cozy-realistic');
  });

  test('boş gövde {} de kabul edilir; zaten bitmiş müzikte dosyaya dokunulmaz', async () => {
    const before = await readJson('music-plan');
    const response = await send('POST', '/api/projects/music-plan/music/complete', { body: {} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).readiness.music.ready, true);
    assert.equal(await readJson('music-plan'), before);
  });

  test('ses dosyası yoksa 409, project.json değişmez', async () => {
    await writeProjectFolder('music-empty', {
      project: { music: plan(['pending', 'pending']) },
      files: ['resimler/MASTER.png'],
    });
    const before = await readJson('music-empty');
    const response = await postEmpty('/api/projects/music-empty/music/complete');
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'No audio files in the project audio folder');
    assert.ok(body.audioDir.endsWith('audio'));
    assert.equal(await readJson('music-empty'), before);
  });

  test('parça planı yoksa 409', async () => {
    const response = await postEmpty('/api/projects/fresh-no-plan/music/complete');
    assert.equal(response.status, 404);
    await writeProjectFolder('fresh-no-plan');
    const noPlan = await postEmpty('/api/projects/fresh-no-plan/music/complete');
    assert.equal(noPlan.status, 409);
    assert.deepEqual(await noPlan.json(), { error: 'Project has no music plan', audioCount: 0 });
  });

  test('bozuk project.json 409; kimlik ve gövde hataları', async () => {
    const broken = await postEmpty('/api/projects/broken-json/music/complete');
    assert.equal(broken.status, 409);
    assert.equal((await broken.json()).error, 'project.json is invalid');

    const traversal = await postEmpty('/api/projects/..%2Fmusic-plan/music/complete');
    assert.equal(traversal.status, 400);
    assert.deepEqual(await traversal.json(), { error: 'Invalid project id' });

    const extra = await send('POST', '/api/projects/music-empty/music/complete', { body: { force: true } });
    assert.equal(extra.status, 400);
    assert.deepEqual(await extra.json(), { error: 'Unknown field: force' });

    const plain = await send('POST', '/api/projects/music-empty/music/complete', {
      body: '{}', headers: { 'content-type': 'text/plain' },
    });
    assert.equal(plain.status, 415);

    assert.equal((await send('GET', '/api/projects/music-empty/music/complete')).status, 405);
  });
});

describe('build — arka planda build.js', () => {
  test('hazır olmayan proje 409 ve eksikler', async () => {
    await writeProjectFolder('fresh');
    const response = await send('POST', '/api/projects/fresh/build', { body: {} });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'Project is not ready to build');
    assert.equal(body.step.id, 'faz1');
    assert.deepEqual(body.missing, ['clip', 'music']);
    assert.equal(spawned.length, 0);
  });

  test('çıktı varken overwrite verilmezse 409', async () => {
    const response = await send('POST', '/api/projects/done/build', { body: {} });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, 'Output already exists');
    assert.ok(body.output.endsWith('final_ambient.mp4'));
    assert.equal(spawned.length, 0);
  });

  test('bozuk gövde 400, olmayan proje 404, geçersiz kimlik 400, kimlik yoksa 400', async () => {
    assert.equal((await send('POST', '/api/projects/ready/build', { body: { overwrite: 'yes' } })).status, 400);
    assert.equal((await send('POST', '/api/projects/nope/build', { body: {} })).status, 404);
    assert.equal((await send('POST', '/api/projects/..%2Fready/build', { body: {} })).status, 400);
    assert.equal((await send('GET', '/api/projects/..%2Fready/build')).status, 400);
    assert.equal((await send('GET', '/api/projects//build')).status, 400);
    assert.equal((await send('GET', '/api/projects/nope/build')).status, 404);
    assert.equal(spawned.length, 0);
  });

  test('başlatır (202), aynı anda ikinci montaj 409, bitince durum ve log', async () => {
    const idle = await send('GET', '/api/projects/ready/build');
    const idleBody = await idle.json();
    assert.equal(idleBody.state, 'idle');
    assert.equal(idleBody.output.exists, false);

    const started = await send('POST', '/api/projects/ready/build', {
      body: {},
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    assert.equal(started.status, 202);
    const job = await started.json();
    assert.equal(job.state, 'running');
    assert.equal(job.projectId, 'ready');
    assert.equal(job.overwrite, false);

    assert.equal(spawned.length, 1);
    const [{ command, args, options, child }] = spawned;
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ['X:\\repo\\build.js', '--project', join(videosDir, 'ready', 'project.json')]);
    assert.equal(options.cwd, 'X:\\repo');

    const second = await send('POST', '/api/projects/done/build', { body: { overwrite: true } });
    assert.equal(second.status, 409);
    assert.deepEqual(await second.json(), { error: 'A build is already running', projectId: 'ready' });
    assert.equal(spawned.length, 1);

    child.stdout.write('[build] başlıyor.\n[video] bi');
    child.stdout.write('tti\n');
    child.stderr.write('[audio] UYARI: x');
    await new Promise((resolveTick) => setImmediate(resolveTick));
    child.emit('close', 0, null);

    const finished = await (await send('GET', '/api/projects/ready/build')).json();
    assert.equal(finished.state, 'succeeded');
    assert.equal(finished.exitCode, 0);
    assert.deepEqual(finished.log, ['[build] başlıyor.', '[video] bitti', '[audio] UYARI: x']);
    assert.equal(typeof finished.finishedAt, 'string');
  });

  test('overwrite ile yeniden montaj --overwrite geçer; başarısız çıkış failed olur', async () => {
    spawned.length = 0;
    const started = await send('POST', '/api/projects/done/build', { body: { overwrite: true } });
    assert.equal(started.status, 202);
    assert.equal(spawned[0].args.at(-1), '--overwrite');
    spawned[0].child.emit('close', 1, null);
    const failed = await (await send('GET', '/api/projects/done/build')).json();
    assert.equal(failed.state, 'failed');
    assert.equal(failed.exitCode, 1);
  });

  test('süreç başlatılamazsa failed ve kilit bırakılır', () => {
    const jobs = createBuildJobs({
      spawnFn: () => { throw new Error('spawn EPERM'); },
      repoRoot: 'X:\\repo',
    });
    const job = jobs.start('a', { projectPath: 'X:\\a\\project.json', overwrite: false });
    assert.equal(job.state, 'failed');
    assert.match(job.error, /spawn EPERM/);
    const errored = createBuildJobs({ spawnFn: fakeSpawn, repoRoot: 'X:\\repo' });
    spawned.length = 0;
    errored.start('b', { projectPath: 'X:\\b\\project.json', overwrite: false });
    spawned[0].child.emit('error', new Error('ENOENT'));
    assert.equal(errored.get('b').state, 'failed');
    assert.equal(errored.start('c', { projectPath: 'X:\\c\\project.json', overwrite: false }).state, 'running');
  });
});

describe('klip seçim ekranı — liste ve önizleme', () => {
  before(async () => {
    const dir = await writeProjectFolder('clip-pick', {
      project: { clip: './videolar/b.mp4', video: { cropBottom: 0, aspect: '16:9' } },
      files: ['videolar/notes.txt', 'videolar/sub/nested.mp4'],
    });
    for (const file of ['a.mp4', 'b.mp4', 'broken.mp4', 'audio-only.mp4']) {
      await writeFile(join(dir, 'videolar', file), file);
    }
    // videolar/ proje dışına bağlanmış junction: klipler listelenmez, seçilemez, sunulmaz.
    const linked = join(videosDir, 'clip-linked');
    await mkdir(linked);
    await writeFile(join(linked, 'project.json'), JSON.stringify({ clip: '', video: { cropBottom: 150 } }));
    await symlink(join(dir, 'videolar'), join(linked, 'videolar'), 'junction');
  });

  test('GET /clips geçerli klipleri seçim, önizleme adresi ve metadata ile döndürür', async () => {
    const response = await send('GET', '/api/projects/clip-pick/clips');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.selected, 'b.mp4');
    assert.deepEqual(body.clips.map((clip) => clip.file), ['a.mp4', 'audio-only.mp4', 'b.mp4', 'broken.mp4']);

    const [a, audioOnly, b, broken] = body.clips;
    assert.deepEqual(a, {
      file: 'a.mp4',
      selected: false,
      previewUrl: '/api/projects/clip-pick/assets/video/a.mp4',
      size: 5,
      mtimeMs: a.mtimeMs,
      metadata: { duration: 6, width: 1920, height: 1080, fps: 24, videoCodec: 'h264', hasAudio: false },
      metadataError: null,
    });
    assert.equal(typeof a.mtimeMs, 'number');
    assert.equal(b.selected, true);
    assert.equal(broken.metadata, null);
    assert.match(broken.metadataError, /bozuk/);
    assert.equal(audioOnly.metadata, null);

    // Önizleme adresi gerçekten dosyayı sunar.
    const preview = await send('GET', a.previewUrl);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'video/mp4');
    assert.equal(await preview.text(), 'a.mp4');
  });

  test('önizlenen klip seçilebilir; crop değeri korunur', async () => {
    const response = await send('PUT', '/api/projects/clip-pick/clip', { body: { file: 'a.mp4' } });
    assert.equal(response.status, 200);
    const project = await response.json();
    assert.equal(project.readiness.clip.selected, './videolar/a.mp4');
    assert.deepEqual(project.readiness.video, { ready: true, cropBottom: 0, watermark: false, defaultCropBottom: 150 });
    const clips = await (await send('GET', '/api/projects/clip-pick/clips')).json();
    assert.equal(clips.selected, 'a.mp4');
  });

  test('video önizlemesi yalnızca videolar/*.mp4; klip yoksa boş liste', async () => {
    for (const file of ['notes.txt', 'nested.mp4', 'missing.mp4', '..%2Fproject.json', 'sub%2Fnested.mp4']) {
      const status = (await send('GET', `/api/projects/clip-pick/assets/video/${file}`)).status;
      assert.ok(status === 404 || status === 400, `${file}: ${status}`);
    }
    assert.equal((await send('GET', '/api/projects/ready/assets/video/in.mp4')).status, 200);
    assert.deepEqual(await (await send('GET', '/api/projects/nope/clips')).json(), { error: 'Project not found' });
    await writeProjectFolder('clip-empty');
    assert.deepEqual(await (await send('GET', '/api/projects/clip-empty/clips')).json(), { selected: null, clips: [] });
    assert.equal((await send('GET', '/api/projects/..%2Fready/clips')).status, 400);
    assert.equal((await send('DELETE', '/api/projects/ready/clips')).status, 405);
  });

  test('proje dışına bağlanan videolar/ klipleri listelenmez, seçilemez, sunulmaz', async () => {
    const body = await (await send('GET', '/api/projects/clip-linked/clips')).json();
    assert.deepEqual(body, { selected: null, clips: [] });
    const select = await send('PUT', '/api/projects/clip-linked/clip', { body: { file: 'a.mp4' } });
    assert.equal(select.status, 422);
    assert.equal((await send('GET', '/api/projects/clip-linked/assets/video/a.mp4')).status, 404);
  });
});

describe('watermark / cropBottom', () => {
  const crop = (id, body) => send('PUT', `/api/projects/${id}/crop`, { body });
  const readJson = async (id) => JSON.parse(await readFile(join(videosDir, id, 'project.json'), 'utf8'));

  test('GET readiness.video mevcut project.json değerini gösterir', async () => {
    const body = await (await send('GET', '/api/projects/ready')).json();
    assert.deepEqual(body.readiness.video, { ready: true, cropBottom: 150, watermark: true, defaultCropBottom: 150 });
  });

  test('watermark kapat/aç panel kuralıyla; diğer video alanları korunur', async () => {
    await writeProjectFolder('crop-toggle', { project: { video: { cropBottom: 90, aspect: '16:9', crf: 20 } } });

    const on = await crop('crop-toggle', { watermark: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).readiness.video.cropBottom, 90); // pozitif değer korunur

    const off = await (await crop('crop-toggle', { watermark: false })).json();
    assert.deepEqual(off.readiness.video, { ready: true, cropBottom: 0, watermark: false, defaultCropBottom: 150 });
    assert.deepEqual((await readJson('crop-toggle')).video, { cropBottom: 0, aspect: '16:9', crf: 20 });

    const reopened = await (await crop('crop-toggle', { watermark: true })).json();
    assert.equal(reopened.readiness.video.cropBottom, 150); // 0'dan açılınca varsayılan

    const custom = await (await crop('crop-toggle', { cropBottom: 120, watermark: true })).json();
    assert.equal(custom.readiness.video.cropBottom, 120);
    assert.equal(custom.projectJson.data.video.cropBottom, 120);
    assert.equal((await crop('crop-toggle', { cropBottom: 0 })).status, 200);
    assert.equal((await readJson('crop-toggle')).video.cropBottom, 0);
  });

  test('geçersiz gövde 400, dosyaya dokunulmaz', async () => {
    await writeProjectFolder('crop-invalid');
    const before = await readJson('crop-invalid');
    for (const body of [
      {}, { cropBottom: -1 }, { cropBottom: 1.5 }, { cropBottom: '150' }, { watermark: 'yes' },
      { watermark: false, cropBottom: 150 }, { watermark: true, cropBottom: 0 }, { cropBottom: 150, aspect: 'off' },
    ]) {
      assert.equal((await crop('crop-invalid', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await crop('crop-invalid', '')).status, 400); // boş gövde
    assert.equal((await crop('..%2Fready', { watermark: false })).status, 400);
    assert.equal((await crop('nope', { watermark: false })).status, 404);
    assert.deepEqual(await readJson('crop-invalid'), before);
  });

  test('project.json bozuk ya da video nesne değilse 409', async () => {
    const dir = await writeProjectFolder('crop-broken');
    await writeFile(join(dir, 'project.json'), '{ bozuk');
    assert.equal((await crop('crop-broken', { watermark: false })).status, 409);
    await writeFile(join(dir, 'project.json'), '{"video": "x"}');
    const response = await crop('crop-broken', { cropBottom: 0 });
    assert.equal(response.status, 409);
    assert.match((await response.json()).problem, /"video" bir nesne/);
  });

  test('cropBottom yoksa readiness eksik gösterir ve build başlamaz', async () => {
    await writeProjectFolder('crop-missing', {
      project: { clip: './videolar/in.mp4', video: { aspect: '16:9' } },
      files: ['resimler/MASTER.png', 'videolar/in.mp4', 'audio/01.mp3'],
    });
    const project = await (await send('GET', '/api/projects/crop-missing')).json();
    assert.equal(project.step.id, 'build'); // yalnızca kırpma eksik
    assert.deepEqual(project.readiness.video, { ready: false, cropBottom: null, watermark: null, defaultCropBottom: 150 });
    assert.ok(project.readiness.build.missing.includes('cropBottom'));

    spawned.length = 0;
    const blocked = await send('POST', '/api/projects/crop-missing/build', { body: {} });
    assert.equal(blocked.status, 409);
    assert.ok((await blocked.json()).missing.includes('cropBottom'));
    assert.equal(spawned.length, 0);
  });
});

describe('asset önizleme — salt okunur', () => {
  const asset = (id, type, file, headers) => send('GET', `/api/projects/${id}/assets/${type}/${file}`, { headers });

  before(async () => {
    const dir = await writeProjectFolder('assets', {
      project: { clip: './videolar/clip.mp4' },
      files: ['references/notes.txt'],
    });
    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'png-bytes');
    await writeFile(join(dir, 'resimler', 'Master1.jpg'), 'variant');
    await writeFile(join(dir, 'resimler', 'style-ref.webp'), 'webp');
    await writeFile(join(dir, 'references', 'a.jpg'), 'jpg');
    await writeFile(join(dir, 'videolar', 'clip.mp4'), '0123456789');
    await writeFile(join(dir, 'videolar', 'other.mp4'), 'other');
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), 'output');
    // Klip yolu project.json'da proje dışını gösteriyor.
    await writeProjectFolder('outside', { project: { clip: '../assets/videolar/clip.mp4' } });
  });

  test('izinli dosyalar gerçek içerik ve MIME ile döner', async () => {
    const cases = [
      ['master', 'MASTER.png', 'image/png', 'png-bytes'],
      ['reference', 'a.jpg', 'image/jpeg', 'jpg'],
      ['reference', 'style-ref.webp', 'image/webp', 'webp'],
      ['clip', 'clip.mp4', 'video/mp4', '0123456789'],
      ['output', 'final_ambient.mp4', 'video/mp4', 'output'],
    ];
    for (const [type, file, mime, content] of cases) {
      const response = await asset('assets', type, file);
      assert.equal(response.status, 200, `${type}/${file}`);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await response.text(), content);
    }
  });

  test('Range isteği 206, karşılanamayan aralık 416', async () => {
    const partial = await asset('assets', 'clip', 'clip.mp4', { range: 'bytes=2-5' });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await partial.text(), '2345');
    const suffix = await asset('assets', 'clip', 'clip.mp4', { range: 'bytes=-3' });
    assert.equal(await suffix.text(), '789');
    const bad = await asset('assets', 'clip', 'clip.mp4', { range: 'bytes=10-' });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */10');
  });

  test('türün listesinde olmayan dosya 404', async () => {
    for (const [type, file] of [
      ['master', 'Master1.jpg'],      // açı varyantı master değil
      ['master', 'a.jpg'],            // başka türün dosyası
      ['clip', 'other.mp4'],          // seçili olmayan klip
      ['reference', 'notes.txt'],     // izinsiz uzantı
      ['reference', 'missing.jpg'],
      ['output', 'final_ambient.mp4'],
    ]) {
      const id = type === 'output' ? 'ready' : 'assets'; // ready'de çıktı yok
      const response = await asset(id, type, file);
      assert.equal(response.status, 404, `${type}/${file}`);
      assert.deepEqual(await response.json(), { error: 'Asset not found' });
    }
    // project.json proje dışını gösterse de sunulmaz.
    assert.equal((await asset('outside', 'clip', 'clip.mp4')).status, 404);
  });

  test('geçersiz tür, dosya adı ve proje kimliği reddedilir', async () => {
    assert.equal((await asset('assets', 'project', 'project.json')).status, 400);
    assert.equal((await asset('assets', 'constructor', 'x.png')).status, 400);
    for (const file of ['..%2Fproject.json', '..%5C..%5Cready%5Cresimler%5CMASTER.png', 'C%3A%5CWindows%5Cwin.ini', '%00.png', '%E0%A4%A']) {
      assert.equal((await asset('assets', 'master', file)).status, 400, file);
    }
    assert.equal((await asset('..%2Fassets', 'master', 'MASTER.png')).status, 400);
    assert.equal((await asset('nope', 'master', 'MASTER.png')).status, 404);
    // Normalleşen yol başka rotaya düşer; dosya sunulmaz.
    assert.equal((await asset('assets', 'master', '../../../project.json')).status, 404);
    assert.equal((await asset('assets', 'master', '%2E%2E')).status, 404);
    assert.equal((await send('POST', '/api/projects/assets/assets/master/MASTER.png', { body: {} })).status, 405);
  });
});

describe('build sonucu — çıktı, hata ve yeniden montaj', () => {
  const readyFiles = ['resimler/MASTER.png', 'videolar/in.mp4', 'audio/01.mp3'];
  const startBuildRequest = (id, body = {}) => send('POST', `/api/projects/${id}/build`, { body });
  const lastChild = () => spawned.at(-1).child;
  const tick = () => new Promise((resolveTick) => setImmediate(resolveTick));

  test('başarılı montaj: iş durumu, readiness ve asset aynı çıktıyı gösterir', async () => {
    const dir = await writeProjectFolder('build-flow', { project: { clip: './videolar/in.mp4' }, files: readyFiles });
    assert.equal((await startBuildRequest('build-flow')).status, 202);
    const running = await (await send('GET', '/api/projects/build-flow/build')).json();
    assert.equal(running.state, 'running');
    assert.equal(running.output.exists, false);

    // build.js'in teslim adımı: video + tracklist out/ altına.
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), 'final-video');
    await writeFile(join(dir, 'out', 'tracklist.txt'), '00:00 Track 1\n');
    lastChild().stdout.write('Bitti (01:00 dk)\n');
    await tick();
    lastChild().emit('close', 0, null);

    const job = await (await send('GET', '/api/projects/build-flow/build')).json();
    assert.equal(job.state, 'succeeded');
    assert.equal(job.error, null);
    assert.equal(job.exitReason, null);
    assert.deepEqual(job.errorLog, []);
    assert.deepEqual(job.output, {
      exists: true,
      file: 'final_ambient.mp4',
      size: 'final-video'.length,
      mtimeMs: job.output.mtimeMs,
      previewUrl: '/api/projects/build-flow/assets/output/final_ambient.mp4',
      tracklist: {
        exists: true,
        file: 'tracklist.txt',
        size: '00:00 Track 1\n'.length,
        mtimeMs: job.output.tracklist.mtimeMs,
        previewUrl: '/api/projects/build-flow/assets/tracklist/tracklist.txt',
        text: '00:00 Track 1\n',
      },
    });

    const project = await (await send('GET', '/api/projects/build-flow')).json();
    assert.equal(project.step.id, 'done');
    assert.deepEqual(project.readiness.output, job.output);

    const video = await send('GET', job.output.previewUrl);
    assert.equal(video.headers.get('content-type'), 'video/mp4');
    assert.equal(await video.text(), 'final-video');
    const tracklist = await send('GET', job.output.tracklist.previewUrl);
    assert.equal(tracklist.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await tracklist.text(), '00:00 Track 1\n');
    // Tür/MIME eşleşmesi: tracklist başka tür adıyla sunulmaz.
    assert.equal((await send('GET', '/api/projects/build-flow/assets/output/tracklist.txt')).status, 404);

    // Çıktı varken overwrite'sız 409; overwrite ile yeniden montaj.
    const conflict = await startBuildRequest('build-flow');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).existing.length, 2);
    assert.equal((await startBuildRequest('build-flow', { overwrite: true })).status, 202);
    assert.equal(spawned.at(-1).args.at(-1), '--overwrite');
    lastChild().emit('close', 0, null);
  });

  test('başarısız montaj: build.js nedeni, çıkış türü ve stderr logu', async () => {
    await writeProjectFolder('build-fail', { project: { clip: './videolar/in.mp4' }, files: readyFiles });
    assert.equal((await startBuildRequest('build-fail')).status, 202);
    lastChild().stdout.write('[video] Video hazırlığı başlıyor.\n');
    lastChild().stderr.write('[audio] UYARI: sessizlik\n\nBuild başarısız: ffmpeg çıkış kodu 1\n');
    await tick();
    lastChild().emit('close', 1, null);

    const job = await (await send('GET', '/api/projects/build-fail/build')).json();
    assert.equal(job.state, 'failed');
    assert.equal(job.exitCode, 1);
    assert.equal(job.exitReason, 'build-failed');
    assert.equal(job.error, 'ffmpeg çıkış kodu 1');
    assert.deepEqual(job.errorLog, ['[audio] UYARI: sessizlik', 'Build başarısız: ffmpeg çıkış kodu 1']);
    assert.ok(job.log.includes('[video] Video hazırlığı başlıyor.'));
    assert.equal(job.output.exists, false);

    // Konfig hatası (çıkış 2): stderr'in ilk satırı neden olur.
    assert.equal((await startBuildRequest('build-fail')).status, 202);
    lastChild().stderr.write('project.json geçersiz (X:\\p\\project.json):\n  - clip: dosya yok\n');
    await tick();
    lastChild().emit('close', 2, null);
    const config = await (await send('GET', '/api/projects/build-fail/build')).json();
    assert.equal(config.exitReason, 'config-invalid');
    assert.equal(config.error, 'project.json geçersiz (X:\\p\\project.json):');

    // Sinyalle biten süreç: iptal; stderr yoksa çıkış kodu yazılır.
    assert.equal((await startBuildRequest('build-fail')).status, 202);
    lastChild().emit('close', null, 'SIGTERM');
    const cancelled = await (await send('GET', '/api/projects/build-fail/build')).json();
    assert.equal(cancelled.exitCode, 130);
    assert.equal(cancelled.exitReason, 'cancelled');
    assert.equal(cancelled.error, 'build.js exited with code 130');
    assert.deepEqual(cancelled.errorLog, []); // yeni iş eski logu taşımaz
  });

  test('yalnızca tracklist kalmışsa da overwrite gerekir (build.js ile aynı kural)', async () => {
    const dir = await writeProjectFolder('build-tracklist', {
      project: { clip: './videolar/in.mp4' },
      files: [...readyFiles, 'out/tracklist.txt'],
    });
    const response = await startBuildRequest('build-tracklist');
    assert.equal(response.status, 409);
    assert.deepEqual((await response.json()).existing, [join(dir, 'out', 'tracklist.txt')]);
    const project = await (await send('GET', '/api/projects/build-tracklist')).json();
    assert.equal(project.readiness.output.exists, false);
    assert.equal(project.readiness.output.tracklist.exists, true);
    assert.equal((await startBuildRequest('build-tracklist', { overwrite: true })).status, 202);
    lastChild().emit('close', 0, null);
  });

  test('proje dışına yazılan çıktı görünür ama sunulmaz', async () => {
    const dir = await writeProjectFolder('build-outside', {
      project: { clip: './videolar/in.mp4', output: { dir: '../shared-out', name: 'shared.mp4' } },
      files: readyFiles,
    });
    await mkdir(join(dir, '..', 'shared-out'), { recursive: true });
    await writeFile(join(dir, '..', 'shared-out', 'shared.mp4'), 'x');
    const project = await (await send('GET', '/api/projects/build-outside')).json();
    assert.equal(project.readiness.output.exists, true);
    assert.equal(project.readiness.output.previewUrl, null);
    assert.equal((await send('GET', '/api/projects/build-outside/assets/output/shared.mp4')).status, 404);
  });
});

describe('HTTP katmanı', () => {
  test('bilinen yolda yanlış yöntem 405, bilinmeyen yol 404', async () => {
    const wrong = await send('DELETE', '/api/projects/ready');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'GET');
    assert.equal((await send('PUT', '/api/projects', { body: {} })).status, 405);
    assert.equal((await send('GET', '/api/projects/ready/unknown')).status, 404);
  });

  test('localhost olmayan Host başlığı 403 (DNS rebinding)', async () => {
    const status = await new Promise((resolveStatus, rejectStatus) => {
      const req = httpRequest(`${url}/api/projects`, { headers: { host: 'evil.example:3000' } }, (res) => {
        res.resume();
        resolveStatus(res.statusCode);
      });
      req.on('error', rejectStatus);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('canonical akış — 10 adım, diskten kaldığı yer', () => {
  const b64 = (text) => Buffer.from(text).toString('base64');
  const options = () => ({ videosDir });
  const current = async (id) => (await getProject(id, options())).workflow.current;

  test('taze projeden yayına: her adım kanıtla tamamlanır, sıra değişmez', async () => {
    await writeProjectFolder('flow', { project: { video: { aspect: '16:9' } } });
    const fresh = await getProject('flow', options());
    assert.deepEqual(fresh.workflow.steps.map((step) => step.id), [
      'project', 'style', 'reference', 'master', 'angles', 'video', 'music', 'order', 'build', 'publish',
    ]);
    // Kütüphane stili kayıtlı → stil adımı atlanır, sahne referansı istenir.
    assert.equal(fresh.workflow.current, 'reference');

    await uploadProjectImage('flow', { slot: 'scene', name: 'scene.webp', data: b64('s') }, options());
    assert.equal(await current('flow'), 'master');

    await uploadProjectImage('flow', { slot: 'master', name: 'm.jpg', data: b64('m1') }, options());
    await uploadProjectImage('flow', { slot: 'master', name: 'm.png', data: b64('m2') }, options());
    const withMaster = await getProject('flow', options());
    assert.ok(withMaster.master.endsWith('MASTER.png'), 'eski uzantılı MASTER kaldırılır');
    assert.equal(withMaster.workflow.current, 'angles');

    await updateWorkflow('flow', { angles: { wanted: true, count: 2 } }, options());
    await uploadProjectImage('flow', { slot: 'angle', index: 1, name: 'a.jpg', data: b64('a') }, options());
    assert.equal(await current('flow'), 'angles', 'istenen 2 açıdan 1 tanesi var');
    await uploadProjectImage('flow', { slot: 'angle', index: 2, name: 'b.jpg', data: b64('b') }, options());
    const withAngles = await getProject('flow', options());
    assert.equal(withAngles.angles.length, 2);
    assert.ok(withAngles.master.endsWith('MASTER.png'), 'açı dosyası MASTER sayılmaz');
    assert.equal(withAngles.workflow.current, 'video');

    await uploadProjectClip('flow', { name: 'loop.mp4', data: b64('v') }, options());
    assert.equal(await current('flow'), 'video', 'klip seçilip kırpma kaydedilene kadar');
    await selectClip('flow', { file: 'loop.mp4' }, options());
    assert.equal(await current('flow'), 'video', 'kırpma kaydı yok');
    await updateCrop('flow', { watermark: true, cropBottom: 150 }, options());
    assert.equal(await current('flow'), 'music');

    await uploadProjectAudio('flow', { name: 'b-song.mp3', data: b64('1') }, options());
    await uploadProjectAudio('flow', { name: 'a-song.mp3', data: b64('2') }, options());
    assert.equal(await current('flow'), 'order');

    await assert.rejects(
      updateTrackOrder('flow', { mode: 'manual', order: ['b-song.mp3'] }, options()),
      (error) => error.status === 422,
    );
    const ordered = await updateTrackOrder('flow', { mode: 'manual', order: ['b-song.mp3', 'a-song.mp3'] }, options());
    assert.deepEqual(ordered.projectJson.data.order, ['b-song.mp3', 'a-song.mp3']);
    assert.equal(ordered.projectJson.data.workflow.order, 'manual');
    assert.equal(ordered.workflow.current, 'build');
    assert.equal(ordered.readiness.build.ready, true);

    const alpha = await updateTrackOrder('flow', { mode: 'alphabetical' }, options());
    assert.deepEqual(alpha.projectJson.data.order, ['a-song.mp3', 'b-song.mp3']);

    await mkdir(join(videosDir, 'flow', 'out'), { recursive: true });
    await writeFile(join(videosDir, 'flow', 'out', 'final_ambient.mp4'), 'x');
    const published = await getProject('flow', options());
    assert.equal(published.workflow.current, 'publish');
    assert.ok(published.workflow.steps.slice(0, 9).every((step) => step.status === 'done'));
  });

  test('açı istemeyen proje adımı atlar; eski projede sonraki kanıt önceki adımı tamamlar', async () => {
    await writeProjectFolder('skip-angles', { files: ['resimler/MASTER.png'] });
    assert.equal(await current('skip-angles'), 'angles');
    const skipped = await updateWorkflow('skip-angles', { angles: { wanted: false } }, options());
    assert.equal(skipped.workflow.current, 'video');
    assert.equal(skipped.workflow.steps.find((step) => step.id === 'angles').skipped, true);

    // Eski proje: scene-ref ve workflow kaydı yok, klip + müzik var, sıra yok → Sıralama.
    await writeProjectFolder('legacy', {
      project: { clip: './videolar/in.mp4' },
      files: ['resimler/MASTER.png', 'videolar/in.mp4', 'audio/01.mp3'],
    });
    const legacy = await getProject('legacy', options());
    assert.equal(legacy.workflow.current, 'order');
    assert.deepEqual(
      legacy.workflow.steps.filter((step) => step.status === 'done').map((step) => step.id),
      ['project', 'style', 'reference', 'master', 'angles', 'video', 'music'],
    );
  });

  test('özel stil üretilmeden stil adımında kalınır; geçersiz istekler reddedilir', async () => {
    await writeProjectFolder('custom-flow', { project: { style: 'custom-generated' } });
    assert.equal(await current('custom-flow'), 'style');
    await writeFile(join(videosDir, 'custom-flow', 'STYLE_BLOCK.txt'), 'block');
    assert.equal(await current('custom-flow'), 'reference');

    const bad = (promise, status) => assert.rejects(promise, (error) => error.status === status);
    await bad(uploadProjectImage('custom-flow', { slot: 'other', name: 'a.png', data: b64('x') }, options()), 400);
    await bad(uploadProjectImage('custom-flow', { slot: 'angle', index: 9, name: 'a.png', data: b64('x') }, options()), 400);
    await bad(uploadProjectImage('custom-flow', { slot: 'scene', name: 'a.gif', data: b64('x') }, options()), 400);
    await bad(uploadProjectImage('custom-flow', { slot: 'scene', name: '../a.png', data: b64('x') }, options()), 400);
    await bad(uploadProjectClip('custom-flow', { name: 'a.mov', data: b64('x') }, options()), 400);
    await bad(uploadProjectAudio('custom-flow', { name: 'a.mp3', data: '' }, options()), 400);
    await bad(updateWorkflow('custom-flow', { angles: { wanted: true, count: 0 } }, options()), 400);
    await bad(updateTrackOrder('custom-flow', { mode: 'alphabetical' }, options()), 409);
  });

  test('promptlar yalnızca kopyalanacak kod bloklarını döndürür', async () => {
    const prompts = await getProjectPrompts('flow', { videosDir, stylesDir: STYLES_DIR });
    assert.ok(prompts.master.startsWith('Image 1 = environment'));
    assert.ok(!prompts.master.includes('Faz 1'));
    assert.equal(prompts.angles.length, 5);
    assert.equal(prompts.angles[0].title, 'Extreme low angle');
    assert.ok(prompts.angles[0].prompt.startsWith('Image 1 = master frame'));
    assert.ok(prompts.video.startsWith('Subtle looping motion:'));
  });
});

describe('tek resim modu ve proje küçük resmi', () => {
  test('POST videoSource=image → project.json video.source image, kırpma 0; geçersiz değer 400', async () => {
    const created = await send('POST', '/api/projects', { body: { name: 'still album', style: 'watercolor', videoSource: 'image' } });
    assert.equal(created.status, 201);
    const json = JSON.parse(await readFile(join(videosDir, 'still album', 'project.json'), 'utf8'));
    assert.deepEqual(json.video, { source: 'image', cropBottom: 0, aspect: '16:9' });

    const bad = await send('POST', '/api/projects', { body: { name: 'bad source', style: 'watercolor', videoSource: 'gif' } });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /videoSource must be one of: clip, image/);
  });

  test('görsel seçilir, klip önizlemesi görseli sunar; listede küçük resim adresi', async () => {
    const dir = await writeProjectFolder('still-pick', { project: { video: { source: 'image', cropBottom: 0 } } });
    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'master');
    await writeFile(join(dir, 'resimler', 'Master1.jpg'), 'angle');

    const picked = await send('PUT', '/api/projects/still-pick/clip', { body: { file: 'Master1.jpg' } });
    assert.equal(picked.status, 200);
    assert.equal((await picked.json()).clip.value, './resimler/Master1.jpg');

    const clip = await send('GET', '/api/projects/still-pick/assets/clip/Master1.jpg');
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get('content-type'), 'image/jpeg');

    const list = await (await send('GET', '/api/projects')).json();
    const entry = list.find((p) => p.id === 'still-pick');
    assert.equal(entry.thumbnailUrl, '/api/projects/still-pick/assets/thumbnail/Master1.jpg');
    const thumb = await send('GET', entry.thumbnailUrl);
    assert.equal(thumb.status, 200);
    assert.equal(await thumb.text(), 'angle');
  });

  test('görseli olmayan projede thumbnailUrl null', async () => {
    await writeProjectFolder('no-image');
    const list = await (await send('GET', '/api/projects')).json();
    assert.equal(list.find((p) => p.id === 'no-image').thumbnailUrl, null);
  });
});
