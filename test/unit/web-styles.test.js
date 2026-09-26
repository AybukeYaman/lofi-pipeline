/**
 * Web stil akışları: POST /api/styles (add-style.js),
 * POST /api/projects/:id/style/generate (prep/project-style.js) ve
 * GET /api/projects/:id/master (Faz 1 promptu). Gemini sahte.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';

import { inspectProject, nextStep } from '../../prep/project-status.js';
import { GeminiError } from '../../prep/gemini.js';
import { STYLES_DIR } from '../../prep/styles.js';
import {
  createLibraryStyle, deleteLibraryStyle, generateStyle, getAsset, getLibrary, getMaster, getProject, getStyle, getStyleAsset, updateLibraryStyle,
} from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';

const VALID_STYLE = {
  styleBlock: {
    medium: 'Watercolor on paper',
    lines: 'Soft feathered edges',
    palette: [
      { hex: '#112233', role: 'base' },
      { hex: '#445566', role: 'light' },
      { hex: '#778899', role: 'accent' },
      { hex: '#AABBCC', role: 'shadow' },
      { hex: '#DDEEFF', role: 'highlight' },
    ],
    light: 'Diffused daylight',
    texture: 'Paper grain',
    contrast: 'Low contrast',
    shading: 'Soft washes',
  },
  suggestedAmbient: 'heavyRain',
  motionHints: ['Steam rising gently.', 'Soft rain falling.', 'Candle flame flickering.', 'Curtain swaying.'],
};
const reply = (payload) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] });

let base;
let videosDir;
let stylesDir;
let ambientDir;
let server;
let url;
/** Her testte değiştirilebilen sahte Gemini davranışı. */
let gemini;
let generateCalls;

function send(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  return fetch(`${url}${path}`, init);
}

async function writeProject(name, { style = 'custom-generated', files = [], styleBlock = false } = {}) {
  const dir = join(videosDir, name);
  for (const sub of ['audio', 'resimler', 'videolar', 'references']) await mkdir(join(dir, sub), { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    clip: '', audioDir: './audio', video: { cropBottom: 150 }, output: { dir: './out' }, style, concept: 'Rainy night',
  }, null, 2));
  for (const file of files) await writeFile(join(dir, file), `bytes:${file}`);
  if (styleBlock) await writeFile(join(dir, 'STYLE_BLOCK.txt'), 'old block');
  return dir;
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-styles-'));
  videosDir = join(base, 'videolar');
  stylesDir = join(base, 'styles');
  ambientDir = join(base, 'ambient');
  await mkdir(videosDir);
  await mkdir(join(stylesDir, 'refs'), { recursive: true });
  await mkdir(ambientDir);
  await writeFile(join(ambientDir, 'heavyRain.mp3'), '');

  const geminiOptions = () => ({
    env: gemini.env,
    loadEnvFn: () => {},
    listModelsFn: async () => ({ models: [{ name: 'models/gemini-1.5-flash' }] }),
    generateContentFn: async (args) => {
      generateCalls.push(args);
      return gemini.generate(args);
    },
  });
  server = createWebServer({
    projectApi: {
      getLibrary: () => getLibrary({ stylesDir, ambientDir }),
      getProject: (id) => getProject(id, { videosDir }),
      createLibraryStyle: (body) => createLibraryStyle(body, {
        videosDir, stylesDir, ambientDir, gemini: geminiOptions(),
      }),
      getStyle: (id) => getStyle(id, { stylesDir, ambientDir }),
      getStyleAsset: (id, options) => getStyleAsset(id, { ...options, stylesDir }),
      updateLibraryStyle: (id, body) => updateLibraryStyle(id, body, { stylesDir, ambientDir }),
      deleteLibraryStyle: (id) => deleteLibraryStyle(id, { stylesDir }),
      generateStyle: (id, body) => generateStyle(id, body, { videosDir, ambientDir, gemini: geminiOptions() }),
      getMaster: (id) => getMaster(id, { videosDir, stylesDir: STYLES_DIR }),
      getAsset: (id, type, file) => getAsset(id, type, file, { videosDir }),
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${server.address().port}`;

  await writeProject('refs', { style: 'cozy-realistic', files: ['references/a.jpg', 'references/b.png', 'references/notes.txt'] });
});

beforeEach(() => {
  generateCalls = [];
  gemini = { env: { GEMINI_API_KEY: 'test-key' }, generate: async () => reply(VALID_STYLE) };
});

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(base, { recursive: true, force: true });
});

describe('POST /api/styles — kütüphaneye stil', () => {
  test('proje referansından stil üretir; CLI ile aynı dosyalar, kütüphanede görünür', async () => {
    const response = await send('POST', '/api/styles', { name: 'rainy-watercolor', projectId: 'refs', reference: 'a.jpg' });
    assert.equal(response.status, 201);
    const { style } = await response.json();
    assert.equal(style.name, 'rainy-watercolor');
    assert.equal(style.kind, 'library');
    assert.equal(style.valid, true);
    assert.equal(style.hasReference, true);
    assert.equal(style.suggestedAmbient, 'heavyRain');
    assert.equal(style.styleBlock.medium, 'Watercolor on paper');

    const saved = JSON.parse(await readFile(join(stylesDir, 'rainy-watercolor.json'), 'utf8'));
    assert.equal(saved.name, 'rainy-watercolor');
    assert.equal(await readFile(join(stylesDir, 'refs', 'rainy-watercolor.jpg'), 'utf8'), 'bytes:references/a.jpg');
    assert.equal(generateCalls[0].contents[0].parts[1].inline_data.mime_type, 'image/jpeg');

    const library = await (await send('GET', '/api/library')).json();
    assert.ok(library.styles.some((entry) => entry.name === 'rainy-watercolor' && entry.valid));
  });

  test('var olan ad 409; overwrite ile yenilenir ve eski uzantılı referans silinir', async () => {
    const body = { name: 'rainy-watercolor', projectId: 'refs', reference: 'b.png' };
    const conflict = await send('POST', '/api/styles', body);
    assert.equal(conflict.status, 409);
    assert.equal(generateCalls.length, 0);

    const replaced = await send('POST', '/api/styles', { ...body, overwrite: true });
    assert.equal(replaced.status, 201);
    assert.equal(await readFile(join(stylesDir, 'refs', 'rainy-watercolor.png'), 'utf8'), 'bytes:references/b.png');
    await assert.rejects(stat(join(stylesDir, 'refs', 'rainy-watercolor.jpg')), { code: 'ENOENT' });
  });

  test('doğrulama: ad, ayrılmış ad, alanlar, referans ve proje', async () => {
    const cases = [
      [{ name: 'Bad Name', projectId: 'refs', reference: 'a.jpg' }, 400],
      [{ name: 'custom-generated', projectId: 'refs', reference: 'a.jpg' }, 400],
      [{ name: 'ok-name', projectId: 'refs' }, 400],
      [{ name: 'ok-name', projectId: 'refs', reference: 'a.jpg', extra: 1 }, 400],
      [{ name: 'ok-name', projectId: 'refs', reference: '../project.json' }, 400],
      [{ name: 'ok-name', projectId: 'refs', reference: '..\\..\\x.jpg' }, 400],
      [{ name: 'ok-name', projectId: '../refs', reference: 'a.jpg' }, 400],
      [{ name: 'ok-name', projectId: 'nope', reference: 'a.jpg' }, 404],
      [{ name: 'ok-name', projectId: 'refs', reference: 'notes.txt' }, 422],
      [{ name: 'ok-name', projectId: 'refs', reference: 'missing.jpg' }, 422],
    ];
    for (const [body, status] of cases) {
      const response = await send('POST', '/api/styles', body);
      assert.equal(response.status, status, JSON.stringify(body));
    }
    const missing = await (await send('POST', '/api/styles', cases.at(-1)[0])).json();
    assert.deepEqual(missing.available, ['a.jpg', 'b.png']);
    assert.equal(generateCalls.length, 0);
    await assert.rejects(stat(join(stylesDir, 'ok-name.json')), { code: 'ENOENT' });
  });

  test('API anahtarı yok 503; Gemini hatası ve geçersiz çıktı 502; dosya yazılmaz', async () => {
    const body = { name: 'failing-style', projectId: 'refs', reference: 'a.jpg' };
    gemini.env = {};
    assert.equal((await send('POST', '/api/styles', body)).status, 503);

    gemini.env = { GEMINI_API_KEY: 'test-key' };
    gemini.generate = async () => { throw new GeminiError('quota', { status: 429, quotaExceeded: true }); };
    const upstream = await send('POST', '/api/styles', body);
    assert.equal(upstream.status, 502);
    assert.deepEqual(await upstream.json(), {
      error: 'Style generation failed', problem: 'quota', upstreamStatus: 429, quotaExceeded: true,
    });

    gemini.generate = async () => reply({ ...VALID_STYLE, motionHints: 'not-an-array' });
    const invalid = await send('POST', '/api/styles', body);
    assert.equal(invalid.status, 502);
    assert.match((await invalid.json()).problem, /geçersiz/);
    await assert.rejects(stat(join(stylesDir, 'failing-style.json')), { code: 'ENOENT' });
  });

  test('aynı ada eşzamanlı ikinci istek 409', async () => {
    let release;
    gemini.generate = () => new Promise((resolveGenerate) => { release = () => resolveGenerate(reply(VALID_STYLE)); });
    const body = { name: 'slow-style', projectId: 'refs', reference: 'a.jpg' };
    const first = send('POST', '/api/styles', body);
    while (!release) await new Promise((r) => setImmediate(r));
    const second = await send('POST', '/api/styles', body);
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, 'Generation already in progress');
    release();
    assert.equal((await first).status, 201);
  });

  test('UI AI modalı: concept ve suggestedAmbient ile stil üretir (projectId olmadan)', async () => {
    const body = {
      name: 'cyber-concept',
      concept: 'Cyberpunk neon night rain',
      suggestedAmbient: ['heavyRain'],
    };
    const response = await send('POST', '/api/styles', body);
    assert.equal(response.status, 201);
    const { style } = await response.json();
    assert.equal(style.name, 'cyber-concept');
    assert.equal(style.suggestedAmbient, 'heavyRain');
    assert.match(generateCalls[0].contents[0].parts[0].text, /Cyberpunk neon night rain/);

    const saved = JSON.parse(await readFile(join(stylesDir, 'cyber-concept.json'), 'utf8'));
    assert.equal(saved.name, 'cyber-concept');
  });

  test('UI AI modalı: base64 referenceImages ile stil üretir ve refs/ altına kaydeder', async () => {
    const fakeBase64 = Buffer.from('fake-png-content').toString('base64');
    const body = {
      name: 'pixel-art',
      concept: 'Chiptune pixel mood',
      referenceImages: [{ name: 'pixel.png', data: `data:image/png;base64,${fakeBase64}` }],
    };
    const response = await send('POST', '/api/styles', body);
    assert.equal(response.status, 201);
    const { style } = await response.json();
    assert.equal(style.name, 'pixel-art');
    assert.equal(await readFile(join(stylesDir, 'refs', 'pixel-art.png'), 'utf8'), 'fake-png-content');
    assert.equal(generateCalls[0].contents[0].parts[1].inline_data.mime_type, 'image/png');
  });
});

describe('POST /api/projects/:id/style/generate — projeye özel stil', () => {
  test('references/ görsellerinden üretir; panelle aynı dosyalar, adım ilerler', async () => {
    const dir = await writeProject('custom', { files: ['references/one.png', 'references/two.webp'] });
    assert.equal(nextStep(await inspectProject(dir)).id, 'style-references');

    const response = await send('POST', '/api/projects/custom/style/generate', {});
    assert.equal(response.status, 200);
    const { project, warnings } = await response.json();
    assert.ok(Array.isArray(warnings));
    assert.equal(project.step.id, 'faz1');
    assert.equal(project.readiness.style.ready, true);
    assert.equal(project.projectJson.data.style, 'custom-generated');
    assert.equal(project.projectJson.data.styleBlock.medium, 'Watercolor on paper');
    assert.deepEqual(project.projectJson.data.motionHints, VALID_STYLE.motionHints);

    const block = await readFile(join(dir, 'STYLE_BLOCK.txt'));
    assert.deepEqual([...block.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // panel gibi BOM'lu
    assert.match(block.toString('utf8'), /Watercolor on paper/);

    const parts = generateCalls[0].contents[0].parts;
    assert.equal(parts.length, 3); // prompt + 2 görsel
    assert.match(parts[0].text, /Rainy night/);
  });

  test('stil zaten üretilmişse 409; overwrite ile yeniden üretilir', async () => {
    await writeProject('regen', { files: ['references/one.png'], styleBlock: true });
    const noBody = await send('POST', '/api/projects/regen/style/generate');
    assert.equal(noBody.status, 415); // yazma isteği Content-Type: application/json ister
    assert.equal((await send('POST', '/api/projects/regen/style/generate', {})).status, 409);
    const regenerated = await send('POST', '/api/projects/regen/style/generate', { overwrite: true });
    assert.equal(regenerated.status, 200);
    assert.match(await readFile(join(videosDir, 'regen', 'STYLE_BLOCK.txt'), 'utf8'), /Watercolor/);
  });

  test('kütüphane stilli proje, referanssız proje, bozuk project.json 409', async () => {
    assert.equal((await send('POST', '/api/projects/refs/style/generate', {})).status, 409);

    await writeProject('empty-refs');
    const empty = await send('POST', '/api/projects/empty-refs/style/generate', {});
    assert.equal(empty.status, 409);
    assert.equal((await empty.json()).error, 'No reference images in the project references folder');

    const broken = await writeProject('broken-json', { files: ['references/one.png'] });
    await writeFile(join(broken, 'project.json'), '{ bozuk');
    assert.equal((await send('POST', '/api/projects/broken-json/style/generate', {})).status, 409);
    assert.equal(generateCalls.length, 0);
  });

  test('proje dışına bağlanan references/ kullanılmaz', async () => {
    const dir = join(videosDir, 'linked-refs');
    await mkdir(dir);
    await writeFile(join(dir, 'project.json'), JSON.stringify({ style: 'custom-generated' }));
    await symlink(join(videosDir, 'refs', 'references'), join(dir, 'references'), 'junction');
    const response = await send('POST', '/api/projects/linked-refs/style/generate', {});
    assert.equal(response.status, 409);
    assert.equal(generateCalls.length, 0);
  });

  test('geçersiz gövde/kimlik 400, olmayan proje 404, anahtar yok 503, Gemini hatası 502', async () => {
    await writeProject('failing', { files: ['references/one.png'] });
    assert.equal((await send('POST', '/api/projects/failing/style/generate', { overwrite: 'yes' })).status, 400);
    assert.equal((await send('POST', '/api/projects/..%2Frefs/style/generate', {})).status, 400);
    assert.equal((await send('POST', '/api/projects/nope/style/generate', {})).status, 404);

    gemini.env = {};
    assert.equal((await send('POST', '/api/projects/failing/style/generate', {})).status, 503);

    gemini.env = { GEMINI_API_KEY: 'test-key' };
    gemini.generate = async () => { throw new GeminiError('boom', { status: 500 }); };
    const failed = await send('POST', '/api/projects/failing/style/generate', {});
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).upstreamStatus, 500);

    gemini.generate = async () => ({ candidates: [] });
    const emptyReply = await send('POST', '/api/projects/failing/style/generate', {});
    assert.equal(emptyReply.status, 502);
    assert.match((await emptyReply.json()).problem, /boş/);

    const status = await inspectProject(join(videosDir, 'failing'));
    assert.equal(status.styleBlockExists, false);
    assert.equal(status.projectJson.data.styleBlock, undefined);
  });

  test('15 MB üstü referans 422', async () => {
    const dir = await writeProject('huge');
    await writeFile(join(dir, 'references', 'big.png'), Buffer.alloc(15 * 1024 * 1024 + 1));
    const response = await send('POST', '/api/projects/huge/style/generate', {});
    assert.equal(response.status, 422);
    assert.match((await response.json()).problem, /15 MB/);
    assert.equal(generateCalls.length, 0);
  });

  test('aynı projeye eşzamanlı ikinci üretim 409', async () => {
    await writeProject('busy', { files: ['references/one.png'] });
    let release;
    gemini.generate = () => new Promise((resolveGenerate) => { release = () => resolveGenerate(reply(VALID_STYLE)); });
    const first = send('POST', '/api/projects/busy/style/generate', {});
    while (!release) await new Promise((r) => setImmediate(r));
    const second = await send('POST', '/api/projects/busy/style/generate', { overwrite: true });
    assert.equal(second.status, 409);
    release();
    assert.equal((await first).status, 200);
  });
});

describe('GET /api/projects/:id/master — Faz 1 (elle)', () => {
  test('master yokken panelin Faz 1 promptu ve beklenen dosya döner', async () => {
    const dir = await writeProject('master-wait', { style: 'cozy-realistic' });
    const response = await send('GET', '/api/projects/master-wait/master');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ready, false);
    assert.equal(body.file, null);
    assert.equal(body.previewUrl, null);
    assert.equal(body.folder, join(dir, 'resimler'));
    assert.equal(body.expectedName, 'MASTER.png');
    assert.deepEqual(body.acceptedExtensions, ['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.pjpeg', '.pjp']);
    assert.equal(body.promptError, null);
    assert.match(body.prompt, /Faz 1 — Master frame/);
    assert.match(body.prompt, /Style description:\nMedium \/ technique: \S/); // cozy-realistic stil bloğu
    assert.doesNotMatch(body.prompt, /\{\{/); // şablon tamamen dolduruldu
  });

  test('üretilmiş proje stili prompta girer; MASTER konunca hazır ve önizlenebilir', async () => {
    const dir = await writeProject('master-custom', { files: ['references/one.png'] });
    assert.equal((await send('POST', '/api/projects/master-custom/style/generate', {})).status, 200);
    const waiting = await (await send('GET', '/api/projects/master-custom/master')).json();
    assert.match(waiting.prompt, /Watercolor on paper/);

    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'master-bytes');
    const body = await (await send('GET', '/api/projects/master-custom/master')).json();
    assert.equal(body.ready, true);
    assert.equal(body.file, 'MASTER.png');
    assert.equal(body.previewUrl, '/api/projects/master-custom/assets/master/MASTER.png');
    const preview = await send('GET', body.previewUrl);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(await preview.text(), 'master-bytes');

    const project = await (await send('GET', '/api/projects/master-custom')).json();
    assert.equal(project.readiness.master.ready, true);
    assert.notEqual(project.step.id, 'faz1');
  });

  test('önizlenemeyen uzantıda hazır ama previewUrl yok; geçersiz/olmayan proje', async () => {
    const dir = await writeProject('master-bmp', { style: 'cozy-realistic' });
    await writeFile(join(dir, 'resimler', 'MASTER.bmp'), 'bmp');
    const body = await (await send('GET', '/api/projects/master-bmp/master')).json();
    assert.equal(body.ready, true);
    assert.equal(body.file, 'MASTER.bmp');
    assert.equal(body.previewUrl, null);

    assert.equal((await send('GET', '/api/projects/..%2Frefs/master')).status, 400);
    assert.equal((await send('GET', '/api/projects/nope/master')).status, 404);
    assert.equal((await send('POST', '/api/projects/refs/master', {})).status, 405);
  });

  test('proje dışına bağlanan resimler/ içindeki MASTER hazır sayılmaz', async () => {
    const outside = await writeProject('master-source', { style: 'cozy-realistic' });
    await writeFile(join(outside, 'resimler', 'MASTER.png'), 'x');
    const dir = join(videosDir, 'master-linked');
    await mkdir(dir);
    await writeFile(join(dir, 'project.json'), JSON.stringify({ style: 'cozy-realistic' }));
    await symlink(join(outside, 'resimler'), join(dir, 'resimler'), 'junction');
    const body = await (await send('GET', '/api/projects/master-linked/master')).json();
    assert.equal(body.ready, false);
    assert.equal(body.previewUrl, null);
  });
});

describe('Style CRUD — GET, PUT, DELETE /api/styles/:name & direct creation', () => {
  test('doğrudan styleBlock ile stil oluşturma, okuma, güncelleme ve silme', async () => {
    // 1. Create directly with JSON
    const createRes = await send('POST', '/api/styles', {
      name: 'lofi-sunset',
      styleBlock: {
        medium: 'Digital anime landscape',
        lines: 'Crisp thin lines',
        palette: [
          { hex: '#FFAA00', role: 'sunset sky' },
          { hex: '#223344', role: 'dark silhouette' },
          { hex: '#FFEECC', role: 'sunlight highlights' },
        ],
        light: 'Warm sunset glow',
        texture: 'Smooth digital',
        contrast: 'High contrast',
        shading: 'Two-tone cell shading',
      },
      suggestedAmbient: 'heavyRain',
      motionHints: ['Sun sinking slowly', 'Warm light bouncing'],
    });
    assert.equal(createRes.status, 201);
    const { style: created } = await createRes.json();
    assert.equal(created.name, 'lofi-sunset');

    // 2. GET /api/styles/:name
    const getRes = await send('GET', '/api/styles/lofi-sunset');
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.name, 'lofi-sunset');
    assert.equal(getBody.styleBlock.medium, 'Digital anime landscape');

    // 3. PUT /api/styles/:name (Update)
    const updateRes = await send('PUT', '/api/styles/lofi-sunset', {
      styleBlock: {
        ...getBody.styleBlock,
        medium: 'Updated watercolor anime sunset',
      },
      motionHints: ['Gently floating particles'],
    });
    assert.equal(updateRes.status, 200);
    const { style: updated } = await updateRes.json();
    assert.equal(updated.styleBlock.medium, 'Updated watercolor anime sunset');
    assert.deepEqual(updated.motionHints, ['Gently floating particles']);

    // 4. DELETE /api/styles/:name
    const deleteRes = await send('DELETE', '/api/styles/lofi-sunset');
    assert.equal(deleteRes.status, 200);

    // Verify deleted
    const getAfterDelete = await send('GET', '/api/styles/lofi-sunset');
    assert.equal(getAfterDelete.status, 404);
  });

  test('ayrılmış custom-generated stili güncellenemez ve silinemez', async () => {
    assert.equal((await send('PUT', '/api/styles/custom-generated', {})).status, 400);
    assert.equal((await send('DELETE', '/api/styles/custom-generated')).status, 400);
  });

  test('birden fazla referans görseliyle stil oluşturma, listeleme ve önizleme', async () => {
    const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const png2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mNk+M9QzwAEjAwACPsD/bFw5Z8AAAAASUVORK5CYII=';

    const createRes = await send('POST', '/api/styles', {
      name: 'multi-test-style',
      styleBlock: {
        medium: 'Multi style reference test',
        lines: 'Test lines',
        palette: [{ hex: '#111111', role: 'dark' }, { hex: '#222222', role: 'mid' }, { hex: '#333333', role: 'light' }],
        light: 'Soft light',
        texture: 'Smooth',
        contrast: 'Medium',
        shading: 'Cell',
      },
      motionHints: ['Gentle movement test'],
      referenceImages: [
        { name: 'style-1.png', data: png1 },
        { name: 'style-2.png', data: png2 },
      ],
    });
    assert.equal(createRes.status, 201);
    const { style } = await createRes.json();
    assert.equal(style.name, 'multi-test-style');
    assert.equal(style.hasReference, true);
    assert.equal(style.refUrls.length, 2);

    // Fetch each image
    const img1Res = await send('GET', style.refUrls[0]);
    assert.equal(img1Res.status, 200);
    assert.equal(img1Res.headers.get('content-type'), 'image/png');

    const img2Res = await send('GET', style.refUrls[1]);
    assert.equal(img2Res.status, 200);
    assert.equal(img2Res.headers.get('content-type'), 'image/png');

    // Clean up
    await send('DELETE', '/api/styles/multi-test-style');
  });
});
