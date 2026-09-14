/**
 * Aşama 8c — panel akışları: senaryolu giriş, komutları kaydeden sahte run,
 * geçici videolar/ambient/styles klasörleri. Gerçek komut çalıştırılmaz;
 * new-video gerektiğinde sahte run projeyi runNewVideo ile kurar.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, beforeEach, describe, test } from 'node:test';

import { runPanel } from '../../lofi.js';
import { parseCli as parseNewVideoCli, runNewVideo } from '../../new-video.js';
import { STYLES_DIR } from '../../prep/styles.js';
import {
  addStyle, buildProject, chooseClip, continueProject, createSession, newProject,
} from '../../ui/actions.js';
import { createPrompter } from '../../ui/prompt.js';
import { tempDir } from '../helpers/fixtures.js';

let root;
let n = 0;
let env;

beforeEach(async () => {
  root ??= await tempDir('ui-actions');
  const base = root.path(`t${n++}`);
  env = { base, videosDir: join(base, 'videolar'), ambientDir: join(base, 'ambient'), stylesDir: join(base, 'styles') };
  await mkdir(env.videosDir, { recursive: true });
  await mkdir(env.ambientDir);
  await mkdir(env.stylesDir);
  for (const file of ['campfire.mp3', 'gentleRain.mp3', 'heavyRain.mp3']) await writeFile(join(env.ambientDir, file), '');
  for (const style of ['anime-cel', 'cozy-realistic']) {
    await copyFile(join(STYLES_DIR, `${style}.json`), join(env.stylesDir, `${style}.json`));
  }
});
after(() => root?.cleanup());

/**
 * @param {{ answers?: string[], end?: boolean, code?: number }} [options]
 *   end: yanıtlar bitince giriş kapanır — fazladan soru testi asmaz, PromptClosedError olur
 */
function makeCtx({ answers = [], end = true, code = 0 } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  if (answers.length > 0) input.write(answers.map((a) => `${a}\n`).join(''));
  if (end) input.end();

  const calls = [];
  const run = async (script, args) => {
    calls.push([script, ...args]);
    if (script === 'new-video.js') {
      const cli = parseNewVideoCli(args);
      await runNewVideo(cli);
    }
    return code;
  };

  const ctx = { prompter: createPrompter({ input, output }), run, session: createSession(), ...env };
  return { ctx, calls, input, out: () => text };
}

/** Çıktıda metin görünene kadar bekler (akış soruda duruyor demektir). */
async function waitFor(out, fragment, from = 0) {
  for (let i = 0; i < 400; i++) {
    if (out().indexOf(fragment, from) !== -1) return out().indexOf(fragment, from);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`çıktıda görünmedi: ${JSON.stringify(fragment)}\n--- çıktı ---\n${out()}`);
}

const project = (name = 'v', extra = {}) =>
  runNewVideo({ videoName: name, styleName: 'anime-cel', ...env, ...extra });

describe('newProject', () => {
  test('geçersiz isim tekrar sorulur; öneri başta → --ambient gentleRain; devam etme', async () => {
    const { ctx, calls, out } = makeCtx({ answers: ['video:3', 'video3-Test', '1', '1', 'h'] });
    assert.equal(await newProject(ctx), true);
    assert.deepEqual(calls, [[
      'new-video.js', 'video3-Test', '--style', 'anime-cel', '--ambient', 'gentleRain',
      '--videos-dir', env.videosDir, '--ambient-dir', env.ambientDir, '--styles-dir', env.stylesDir,
    ]]);
    assert.ok(out().includes('geçersiz karakter'));
    assert.ok(out().includes('1) gentleRain (öneri)'));
    assert.equal(ctx.session.project, join(env.videosDir, 'video3-Test'));
  });

  test('ambient 0 → --ambient yok; var olan isim reddedilir', async () => {
    await project('var-olan');
    const { ctx, calls, out } = makeCtx({ answers: ['var-olan', 'yeni', '2', '0', 'h'] });
    assert.equal(await newProject(ctx), true);
    assert.deepEqual(calls[0].slice(0, 4), ['new-video.js', 'yeni', '--style', 'cozy-realistic']);
    assert.ok(!calls[0].includes('--ambient'));
    assert.ok(out().includes('bu isimde klasör zaten var'));
  });

  test('komut başarısızsa proje seçilmez, devam sorulmaz', async () => {
    const { ctx, out } = makeCtx({ answers: ['v', '1', '0'], code: 2 });
    assert.equal(await newProject(ctx), false);
    assert.equal(ctx.session.project, null);
    assert.ok(out().includes('Proje oluşturulamadı (çıkış kodu 2).'));
  });

  test('geçersiz stil dosyası listede ama seçilemez', async () => {
    await writeFile(join(env.stylesDir, 'bozuk.json'), '{}');
    const { ctx, calls, out } = makeCtx({ answers: ['v', '2', '1', '0', 'h'] });
    assert.equal(await newProject(ctx), true);
    assert.ok(out().includes('bozuk (geçersiz stil dosyası)'));
    assert.ok(out().includes('2) seçilemez.'));
    assert.equal(calls[0][3], 'anime-cel');
  });
});

describe('addStyle', () => {
  test('tırnaklı yol temizlenir, yeni ad → --overwrite yok', async () => {
    const image = join(env.base, 'pin görsel.jpg');
    await writeFile(image, 'x');
    const { ctx, calls } = makeCtx({ answers: [`"${image}"`, 'Neo Tokyo', 'neo-tokyo'] });
    assert.equal(await addStyle(ctx), true);
    assert.deepEqual(calls, [[
      'add-style.js', image, '--name', 'neo-tokyo', '--styles-dir', env.stylesDir, '--ambient-dir', env.ambientDir,
    ]]);
  });

  test('olmayan görsel tekrar sorulur; var olan stil + evet → --overwrite, hayır → komut yok', async () => {
    const image = join(env.base, 'a.png');
    await writeFile(image, 'x');

    const yes = makeCtx({ answers: ['yok.png', image, 'anime-cel', 'e'] });
    assert.equal(await addStyle(yes.ctx), true);
    assert.ok(yes.out().includes('Dosya bulunamadı: yok.png'));
    assert.ok(yes.calls[0].includes('--overwrite'));

    const no = makeCtx({ answers: [image, 'anime-cel', 'h'] });
    assert.equal(await addStyle(no.ctx), false);
    assert.deepEqual(no.calls, []);
  });
});

describe('chooseClip ve buildProject', () => {
  test('iki klipten ikincisi → ./videolar/b.mp4; klip yoksa talimat', async () => {
    const { dir } = await project();
    const empty = makeCtx();
    assert.equal(await chooseClip(empty.ctx, dir), false);
    assert.ok(empty.out().includes(`Klip yok — .mp4 dosyasını şuraya koy: ${join(dir, 'videolar')}`));

    await writeFile(join(dir, 'videolar', 'a.mp4'), '');
    await writeFile(join(dir, 'videolar', 'b.mp4'), '');
    const { ctx } = makeCtx({ answers: ['2'] });
    assert.equal(await chooseClip(ctx, dir), true);
    assert.equal(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).clip, './videolar/b.mp4');
  });

  test('çıktı varsa: hayır → komut yok; evet → --overwrite', async () => {
    const { dir } = await project();
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), '');

    const no = makeCtx({ answers: ['h'] });
    assert.equal(await buildProject(no.ctx, dir), false);
    assert.deepEqual(no.calls, []);

    const yes = makeCtx({ answers: ['e'] });
    assert.equal(await buildProject(yes.ctx, dir), true);
    assert.deepEqual(yes.calls, [['build.js', '--project', join(dir, 'project.json'), '--overwrite']]);
  });
});

describe('continueProject', () => {
  test('tam senaryo: Faz 1 → (dosyalar konur) → klip yazılır → Suno talimatı, atla yok', async () => {
    const { dir } = await project();
    const { ctx, input, out } = makeCtx({ end: false });
    ctx.session.project = dir;
    const flow = continueProject(ctx);

    const faz1 = await waitFor(out, 'Faz 1 — Master frame');
    await waitFor(out, 'Seçim: ', faz1);
    assert.ok(out().includes('2) Bu oturumda atla'));
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    input.write('1\n');

    await waitFor(out, 'Klip: in.mp4 — kullanılsın mı?');
    input.write('\n');

    const suno = await waitFor(out, 'Müzik (Suno)');
    await waitFor(out, 'Seçim: ', suno);
    assert.ok(!out().slice(suno).includes('Bu oturumda atla'));
    input.write('0\n');
    await flow;

    assert.equal(JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')).clip, './videolar/in.mp4');
    assert.ok(out().includes('clip = ./videolar/in.mp4'));
    input.end();
  });

  test('atla yalnızca bu oturumda: faz1 atlanınca faz3, yeni oturumda faz1 geri gelir', async () => {
    const { dir } = await project();
    const first = makeCtx({ answers: ['2', '0'] });
    first.ctx.session.project = dir;
    await continueProject(first.ctx);
    assert.ok(first.out().includes('Faz 3 — Klip (image-to-video)'));

    const second = makeCtx({ answers: ['0'] });
    second.ctx.session.project = dir;
    await continueProject(second.ctx);
    assert.ok(second.out().includes('Faz 1 — Master frame'));
    assert.ok(!second.out().includes('Faz 3'));
  });

  test('build 0 döndü ama çıktı yok → ikinci turda uyarı, sonsuz döngü yok', async () => {
    const { dir } = await project();
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    await writeFile(join(dir, 'audio', 'a.m4a'), '');
    const json = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    await writeFile(join(dir, 'project.json'), JSON.stringify({ ...json, clip: './videolar/in.mp4' }));

    const { ctx, calls, out } = makeCtx({ answers: [''] });
    ctx.session.project = dir;
    await continueProject(ctx);
    assert.deepEqual(calls, [['build.js', '--project', join(dir, 'project.json')]]);
    assert.ok(out().includes('Uyarı: "Montaj" tamamlanmış görünmüyor'));
  });

  test('proje yoksa seçim yapılamaz ve akış biter', async () => {
    const { ctx, out } = makeCtx();
    await continueProject(ctx);
    assert.ok(out().includes('Proje yok'));
  });

  test('seçili proje yoksa listeden seçtirir; son değişen en üstte', async () => {
    await project('eski');
    await new Promise((r) => setTimeout(r, 20));
    await project('yeni');
    const { ctx, out } = makeCtx({ answers: ['1', '0'] });
    await continueProject(ctx);
    assert.match(out(), /1\) yeni — Faz 1 — Master frame\n\s+2\) eski — Faz 1/);
    assert.equal(ctx.session.project, join(env.videosDir, 'yeni'));
  });
});

describe('runPanel', () => {
  test('7 → kütüphane, 0 → çıkış kodu 0', async () => {
    const { ctx, out } = makeCtx({ answers: ['7', '0'] });
    assert.equal(await runPanel(ctx), 0);
    assert.ok(out().includes('lofi — üretim paneli'));
    assert.ok(out().includes('anime-cel — öneri: gentleRain · referans görseli yok'));
    assert.ok(out().includes("Ambient'ler: campfire, gentleRain, heavyRain"));
  });

  test('akış hatası paneli düşürmez; EOF → 0', async () => {
    const menu = [{ label: 'patlayan', run: async () => { throw new Error('beklenmeyen'); } }];
    const { ctx, out } = makeCtx({ answers: ['1'] });
    assert.equal(await runPanel(ctx, { menu }), 0);
    assert.ok(out().includes('Hata: beklenmeyen'));
    assert.ok(out().includes('Çıkılıyor.'));
  });

  test('başlıkta seçili proje ve sıradaki adım', async () => {
    const { dir } = await project('baslik');
    const { ctx, out } = makeCtx({ answers: ['0'] });
    ctx.session.project = dir;
    assert.equal(await runPanel(ctx), 0);
    assert.ok(out().includes('Proje: baslik — sıradaki: Faz 1 — Master frame'));
  });
});
