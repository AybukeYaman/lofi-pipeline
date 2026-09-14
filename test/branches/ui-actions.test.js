/**
 * Panel akışları — sahte prompter (değer yanıtları), komutları kaydeden sahte
 * run, geçici videolar/ambient/styles klasörleri. Gerçek komut çalıştırılmaz;
 * new-video gerektiğinde sahte run projeyi runNewVideo ile kurar.
 * Prompter uygulamasından (readline/enquirer) bağımsızdır.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { runPanel } from '../../lofi.js';
import { parseCli as parseNewVideoCli, runNewVideo } from '../../new-video.js';
import { STYLES_DIR } from '../../prep/styles.js';
import {
  addStyle, buildProject, chooseClip, continueProject, createSession, newProject,
} from '../../ui/actions.js';
import { BACK, createFakePrompter, pick } from '../helpers/fake-prompter.js';
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
 * @param {unknown[]} [answers]
 * @param {{ code?: number, closeWhenEmpty?: boolean }} [options]
 */
function makeCtx(answers = [], { code = 0, closeWhenEmpty = false } = {}) {
  const prompter = createFakePrompter(answers, { closeWhenEmpty });
  const calls = [];
  const run = async (script, args) => {
    calls.push([script, ...args]);
    if (script === 'new-video.js') await runNewVideo(parseNewVideoCli(args));
    return code;
  };
  const ctx = { prompter, run, session: createSession(), ...env };
  return { ctx, calls, prompter, out: () => prompter.output() };
}

const project = (name = 'v') => runNewVideo({ videoName: name, styleName: 'anime-cel', ...env });
const readProject = async (dir) => JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
const itemsOf = (prompter, questionPart) =>
  prompter.questions.find((q) => q.question.includes(questionPart))?.items.map((i) => i.label);

describe('newProject', () => {
  test('geçersiz isim tekrar sorulur; öneri başta → --ambient gentleRain; devam etme', async () => {
    const { ctx, calls, prompter, out } = makeCtx(['video:3', 'video3-Test', pick('anime-cel'), pick('gentleRain'), false]);
    assert.equal(await newProject(ctx), true);
    assert.deepEqual(calls, [[
      'new-video.js', 'video3-Test', '--style', 'anime-cel', '--ambient', 'gentleRain',
      '--videos-dir', env.videosDir, '--ambient-dir', env.ambientDir, '--styles-dir', env.stylesDir,
    ]]);
    assert.ok(out().includes('geçersiz karakter'));
    assert.deepEqual(itemsOf(prompter, 'Ambient seç'), ['gentleRain (öneri)', 'campfire', 'heavyRain', 'Ambient yok']);
    assert.equal(ctx.session.project, join(env.videosDir, 'video3-Test'));
  });

  test('"Ambient yok" → --ambient yok; var olan isim reddedilir', async () => {
    await project('var-olan');
    const { ctx, calls, out } = makeCtx(['var-olan', 'yeni', pick('cozy-realistic'), pick('Ambient yok'), false]);
    assert.equal(await newProject(ctx), true);
    assert.deepEqual(calls[0].slice(0, 4), ['new-video.js', 'yeni', '--style', 'cozy-realistic']);
    assert.ok(!calls[0].includes('--ambient'));
    assert.ok(out().includes('bu isimde klasör zaten var'));
  });

  test('isimde geri (Esc) → komut yok', async () => {
    const { ctx, calls } = makeCtx([BACK]);
    assert.equal(await newProject(ctx), false);
    assert.deepEqual(calls, []);
  });

  test('komut başarısızsa proje seçilmez, devam sorulmaz', async () => {
    const { ctx, out } = makeCtx(['v', pick('anime-cel'), pick('Ambient yok')], { code: 2 });
    assert.equal(await newProject(ctx), false);
    assert.equal(ctx.session.project, null);
    assert.ok(out().includes('Proje oluşturulamadı (çıkış kodu 2).'));
  });

  test('geçersiz stil dosyası listede devre dışı; seçilemez', async () => {
    await writeFile(join(env.stylesDir, 'bozuk.json'), '{}');
    const { ctx, prompter } = makeCtx(['v', pick('bozuk')]);
    await assert.rejects(newProject(ctx), /devre dışı seçeneği gösteriyor: bozuk \(geçersiz stil dosyası\)/);
    const style = prompter.questions.find((q) => q.question === 'Stil seç:');
    assert.equal(style.items.find((i) => i.label.startsWith('bozuk')).disabled, true);
  });
});

describe('addStyle', () => {
  test('tırnaklı yol temizlenir, geçersiz ad tekrar sorulur, yeni ad → --overwrite yok', async () => {
    const image = join(env.base, 'pin görsel.jpg');
    await writeFile(image, 'x');
    const { ctx, calls } = makeCtx([`"${image}"`, 'Neo Tokyo', 'neo-tokyo']);
    assert.equal(await addStyle(ctx), true);
    assert.deepEqual(calls, [[
      'add-style.js', image, '--name', 'neo-tokyo', '--styles-dir', env.stylesDir, '--ambient-dir', env.ambientDir,
    ]]);
  });

  test('olmayan görsel tekrar sorulur; var olan stil + evet → --overwrite, hayır → komut yok', async () => {
    const image = join(env.base, 'a.png');
    await writeFile(image, 'x');

    const yes = makeCtx(['yok.png', image, 'anime-cel', true]);
    assert.equal(await addStyle(yes.ctx), true);
    assert.ok(yes.out().includes('Dosya bulunamadı: yok.png'));
    assert.ok(yes.calls[0].includes('--overwrite'));

    const no = makeCtx([image, 'anime-cel', false]);
    assert.equal(await addStyle(no.ctx), false);
    assert.deepEqual(no.calls, []);
  });

  test('görselde ya da adda geri (Esc) → komut yok', async () => {
    const image = join(env.base, 'a.png');
    await writeFile(image, 'x');
    assert.equal(await addStyle(makeCtx([BACK]).ctx), false);
    const { ctx, calls } = makeCtx([image, BACK]);
    assert.equal(await addStyle(ctx), false);
    assert.deepEqual(calls, []);
  });
});

describe('chooseClip ve buildProject', () => {
  test('iki klipten b.mp4 → ./videolar/b.mp4; klip yoksa talimat', async () => {
    const { dir } = await project();
    const empty = makeCtx();
    assert.equal(await chooseClip(empty.ctx, dir), false);
    assert.ok(empty.out().includes(`Klip yok — .mp4 dosyasını şuraya koy: ${join(dir, 'videolar')}`));

    await writeFile(join(dir, 'videolar', 'a.mp4'), '');
    await writeFile(join(dir, 'videolar', 'b.mp4'), '');
    const { ctx } = makeCtx([pick('b.mp4')]);
    assert.equal(await chooseClip(ctx, dir), true);
    assert.equal((await readProject(dir)).clip, './videolar/b.mp4');
  });

  test('tek klip onayı: hayır → clip yazılmaz', async () => {
    const { dir } = await project();
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const { ctx } = makeCtx([false]);
    assert.equal(await chooseClip(ctx, dir), false);
    assert.equal((await readProject(dir)).clip, '');
  });

  test('çıktı varsa: hayır → komut yok; evet → --overwrite', async () => {
    const { dir } = await project();
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), '');

    const no = makeCtx([false]);
    assert.equal(await buildProject(no.ctx, dir), false);
    assert.deepEqual(no.calls, []);

    const yes = makeCtx([true]);
    assert.equal(await buildProject(yes.ctx, dir), true);
    assert.deepEqual(yes.calls, [['build.js', '--project', join(dir, 'project.json'), '--overwrite']]);
  });
});

describe('continueProject', () => {
  test('tam senaryo: Faz 1 → (dosyalar konur) → klip yazılır → Suno talimatı, atla yok', async () => {
    const { dir } = await project();
    const { ctx, out } = makeCtx([
      async ({ items }) => {
        assert.ok(items.some((i) => i.label === 'Bu oturumda atla'));
        await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        return pick('Tekrar kontrol et');
      },
      ({ kind, question }) => {
        assert.equal(kind, 'confirm');
        assert.equal(question, 'Klip: in.mp4 — kullanılsın mı?');
        return true;
      },
      ({ items }) => {
        assert.deepEqual(items.map((i) => i.label), ['Tekrar kontrol et', 'Ana menü']);
        return pick('Ana menü');
      },
    ]);
    ctx.session.project = dir;
    await continueProject(ctx);

    assert.equal((await readProject(dir)).clip, './videolar/in.mp4');
    const text = out();
    assert.ok(text.indexOf('Faz 1 — Master frame') < text.indexOf('clip = ./videolar/in.mp4'));
    assert.ok(text.indexOf('clip = ./videolar/in.mp4') < text.indexOf('Müzik (Suno)'));
  });

  test('atla yalnızca bu oturumda: faz1 atlanınca faz3, yeni oturumda faz1 geri gelir', async () => {
    const { dir } = await project();
    const first = makeCtx([pick('Bu oturumda atla'), pick('Ana menü')]);
    first.ctx.session.project = dir;
    await continueProject(first.ctx);
    assert.ok(first.out().includes('Faz 3 — Klip (image-to-video)'));

    const second = makeCtx([pick('Ana menü')]);
    second.ctx.session.project = dir;
    await continueProject(second.ctx);
    assert.ok(second.out().includes('Faz 1 — Master frame'));
    assert.ok(!second.out().includes('Faz 3'));
  });

  test('build 0 döndü ama çıktı yok → ikinci turda uyarı, sonsuz döngü yok', async () => {
    const { dir } = await project();
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    await writeFile(join(dir, 'audio', 'a.m4a'), '');
    await writeFile(join(dir, 'project.json'), JSON.stringify({ ...(await readProject(dir)), clip: './videolar/in.mp4' }));

    const { ctx, calls, out } = makeCtx([true]);
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
    const { ctx, prompter } = makeCtx([pick('yeni'), pick('Ana menü')]);
    await continueProject(ctx);
    assert.deepEqual(itemsOf(prompter, 'Proje seç'), ['yeni — Faz 1 — Master frame', 'eski — Faz 1 — Master frame', 'Geri']);
    assert.equal(ctx.session.project, join(env.videosDir, 'yeni'));
  });
});

describe('runPanel', () => {
  test("kütüphane → çık → kod 0", async () => {
    const { ctx, out } = makeCtx([pick("Stiller ve ambient'ler"), pick('Çık')]);
    assert.equal(await runPanel(ctx), 0);
    assert.ok(out().includes('lofi — üretim paneli'));
    assert.ok(out().includes('anime-cel — öneri: gentleRain · referans görseli yok'));
    assert.ok(out().includes("Ambient'ler: campfire, gentleRain, heavyRain"));
  });

  test('akış hatası paneli düşürmez; giriş kapanınca (Ctrl+C) → 0', async () => {
    const menu = [{ label: 'patlayan', run: async () => { throw new Error('beklenmeyen'); } }];
    const { ctx, out } = makeCtx([pick('patlayan')], { closeWhenEmpty: true });
    assert.equal(await runPanel(ctx, { menu }), 0);
    assert.ok(out().includes('Hata: beklenmeyen'));
    assert.ok(out().includes('Çıkılıyor.'));
  });

  test('başlıkta seçili proje ve sıradaki adım', async () => {
    const { dir } = await project('baslik');
    const { ctx, prompter } = makeCtx([pick('Çık')]);
    ctx.session.project = dir;
    assert.equal(await runPanel(ctx), 0);
    assert.ok(prompter.questions[0].question.includes('Proje: baslik — sıradaki: Faz 1 — Master frame'));
  });
});
