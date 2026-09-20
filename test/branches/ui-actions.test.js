/**
 * Panel akışları — sahte prompter (değer yanıtları), komutları kaydeden sahte
 * run, geçici videolar/ambient/styles klasörleri. Gerçek komut çalıştırılmaz;
 * new-video gerektiğinde sahte run projeyi runNewVideo ile kurar.
 * Prompter uygulamasından (readline/enquirer) bağımsızdır.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, rename, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { runPanel } from '../../lofi.js';
import { parseCli as parseNewVideoCli, runNewVideo } from '../../new-video.js';
import { createDownloadWatcher } from '../../prep/download-watch.js';
import { STYLES_DIR } from '../../prep/styles.js';
import {
  addStyle, batchBuild, buildProject, chooseClip, continueProject, createSession, newProject,
} from '../../ui/actions.js';
import { inspectProject, nextStep } from '../../prep/project-status.js';
import { BACK, createFakePrompter, pick, picks } from '../helpers/fake-prompter.js';
import { tempDir } from '../helpers/fixtures.js';

import { createTuiStore } from '../../ui/tui/store.js';
import { DashboardView } from '../../ui/tui/dashboard-view.js';

let root;
let n = 0;
let env;
let fakeDownloads;

beforeEach(async () => {
  root ??= await tempDir('ui-actions');
  const base = root.path(`t${n++}`);
  env = { base, videosDir: join(base, 'videolar'), ambientDir: join(base, 'ambient'), stylesDir: join(base, 'styles') };
  await mkdir(env.videosDir, { recursive: true });
  await mkdir(env.ambientDir);
  await mkdir(env.stylesDir);
  // Auto Watch gerçek İndirilenler'e düşmesin: her testin kendi boş klasörü.
  fakeDownloads = join(base, 'downloads');
  await mkdir(fakeDownloads);
  for (const file of ['campfire.mp3', 'gentleRain.mp3', 'heavyRain.mp3']) await writeFile(join(env.ambientDir, file), '');
  for (const style of ['anime-cel', 'cozy-realistic']) {
    await copyFile(join(STYLES_DIR, `${style}.json`), join(env.stylesDir, `${style}.json`));
  }
});
after(() => root?.cleanup());

/**
 * @param {unknown[]} [answers]
 * @param {{ code?: number, codes?: number[], closeWhenEmpty?: boolean }} [options]
 *   codes: build.js çağrılarına sırayla dönen kodlar (bitince `code`)
 */
function makeCtx(answers = [], { code = 0, codes = [], closeWhenEmpty = false } = {}) {
  const prompter = createFakePrompter(answers, { closeWhenEmpty });
  const store = createTuiStore();
  const calls = [];
  const buildCodes = [...codes];
  const run = async (script, args) => {
    calls.push([script, ...args]);
    if (script === 'new-video.js') await runNewVideo(parseNewVideoCli(args));
    if (script === 'build.js') {
      const projArg = args[args.indexOf('--project') + 1];
      const projDir = projArg.endsWith('project.json') ? join(projArg, '..') : projArg;
      await mkdir(join(projDir, 'out'), { recursive: true }).catch(() => {});
      await writeFile(join(projDir, 'out', 'final_ambient.mp4'), '').catch(() => {});
      if (buildCodes.length > 0) return buildCodes.shift();
      return code;
    }
    return code;
  };
  // openFolderFn: gerçek openFolder testte Explorer penceresi açar (spawn detached).
  const openedFolders = [];
  const openFolderFn = (folderPath) => { openedFolders.push(folderPath); return true; };
  const ctx = { prompter, run, store, session: createSession(), openFolderFn, downloadsDir: fakeDownloads, ...env };
  return { ctx, calls, prompter, openedFolders, out: () => prompter.output() };
}

const project = (name = 'v') => runNewVideo({ videoName: name, styleName: 'anime-cel', ...env });
const readProject = async (dir) => JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
const itemsOf = (prompter, questionPart) =>
  prompter.questions.find((q) => q.question.includes(questionPart))?.items.map((i) => i.label);

/** Gerçek izleyici, hızlı saat; start sonrası ve n. poll'da olay tetikleyen kanca. */
const watcherWith = ({ afterStart, onPoll }) => (options) => {
  let now = 0;
  let polls = 0;
  const real = createDownloadWatcher({ ...options, nowFn: () => (now += 1000) });
  return {
    async start() { await real.start(); await afterStart?.(); },
    async poll() { await onPoll?.(++polls); return real.poll(); },
  };
};

describe('newProject', () => {
  test('geçersiz isim tekrar sorulur; öneri başta → --ambient gentleRain; devam etme', async () => {
    const { ctx, calls, prompter, out } = makeCtx(['video:3', 'video3-Test', pick('anime-cel'), picks('gentleRain'), '2:17 AM', '17', pick('default'), false]);
    assert.equal(await newProject(ctx), false);
    assert.ok(out().includes('geçersiz karakter'));
    assert.deepEqual(itemsOf(prompter, 'Select Ambient'), ['gentleRain (öneri)', 'campfire', 'heavyRain', 'Ambient yok']);
  });

  test('"Ambient yok" → --ambient yok; var olan isim reddedilir', async () => {
    await project('var-olan');
    const { ctx, calls, out } = makeCtx(['var-olan', 'yeni', pick('cozy-realistic'), pick('Ambient yok'), '2:17 AM', '17', pick('default'), false]);
    assert.equal(await newProject(ctx), false);
    assert.ok(out().includes('bu isimde klasör zaten var'));
  });

  test('isimde geri (Esc) → komut yok', async () => {
    const { ctx, calls } = makeCtx([BACK]);
    assert.equal(await newProject(ctx), false);
    assert.deepEqual(calls, []);
  });

  test('komut başarısızsa proje seçilmez, devam sorulmaz', async () => {
    const { ctx, out } = makeCtx(['v', pick('anime-cel'), pick('Ambient yok'), '2:17 AM', '17', pick('default'), true], { code: 2 });
    assert.equal(await newProject(ctx), false);
    assert.ok(out().includes('Proje oluşturulamadı (çıkış kodu 2).'));
  });

  test('geçersiz stil dosyası listede devre dışı; seçilemez', async () => {
    await writeFile(join(env.stylesDir, 'bozuk.json'), '{}');
    const { ctx, prompter } = makeCtx(['v', pick('bozuk')]);
    await assert.rejects(newProject(ctx), /devre dışı seçeneği gösteriyor: bozuk \(geçersiz stil dosyası\)/);
    const style = prompter.questions.find((q) => q.question === 'Select Style:');
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

  test('tek klip otomatik seçilir', async () => {
    const { dir } = await project();
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const { ctx } = makeCtx([]);
    assert.equal(await chooseClip(ctx, dir), true);
    assert.equal((await readProject(dir)).clip, './videolar/in.mp4');
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
  test('tam senaryo: Faz 1 → (dosyalar konur) → klip yazılır → otomatik build', async () => {
    const { dir } = await project();
    const data = await readProject(dir);
    delete data.music;
    await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));

    const { ctx, openedFolders } = makeCtx([
      async () => {
        await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
        return pick('⏳ [ Auto Watch ]');
      },
      pick('Son 15 dakika'),
      // Adım 6: Video klip
      async () => {
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        return pick('⏳ [ Auto Watch ]');
      },
      pick('Son 15 dakika'),
      pick('no'),
      // Adım 7: Müzik
      async () => {
        await writeFile(join(dir, 'audio', 'a.m4a'), '');
        return pick('Default music');
      },
      pick('Son 15 dakika'),
      // Adım 10: Yayın
      pick('Ana Menüye Dön'),
    ]);
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 10 });

    assert.equal((await readProject(dir)).clip, './videolar/in.mp4');
    // Klasör yalnızca "Klasörü Aç" ile açılır; adıma girmek Explorer açmaz.
    assert.deepEqual(openedFolders, []);
  });

  test('Klasörü Aç (dosya yok) → bekleme ekranında kalır, Yenile (dosya var) → otomatik ilerler', async () => {
    const { dir } = await project('bekleme-testi');
    const { ctx, out, openedFolders } = makeCtx([
      // FAZ 1: Klasörü Aç seçilir ama dosya eklenmez
      pick('open'),
      // FAZ 1: Dosya eklendikten sonra Yenile seçilir
      async () => {
        await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
        const data = await readProject(dir);
        delete data.music;
        await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));
        return pick('refresh');
      },
      // FAZ 3 (Video): Klasörü Aç seçilir ama dosya eklenmez
      pick('open'),
      // FAZ 3 (Video): Klip eklendikten sonra Yenile seçilir
      async () => {
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        return pick('refresh');
      },
      pick('no'),
      // Audio (Müzik): Klasörü Aç seçilir ama dosya eklenmez
      pick('open'),
      // Audio (Müzik): Müzik eklendikten sonra Yenile seçilir
      async () => {
        await writeFile(join(dir, 'audio', 'track1.mp3'), '');
        return pick('refresh');
      },
      // Yayın: Ana Menüye Dön
      pick('Ana Menüye Dön'),
    ]);
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 10 });

    const outputText = out();
    assert.ok(outputText.includes('[📂 Klasör Açıldı]'));
    assert.ok(outputText.includes('[✓ Master Görseli Algılandı]'));
    assert.ok(outputText.includes('Müzik') || outputText.includes('audio') || outputText.includes('Default music'));
    assert.ok(outputText.includes('[✓ Video Klip Algılandı & Bağlandı]'));

    // "Klasörü Aç" her adımda doğru klasörü açar.
    assert.deepEqual(openedFolders, [join(dir, 'resimler'), join(dir, 'videolar'), join(dir, 'audio')]);
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
    const { ctx, prompter } = makeCtx([pick('yeni'), pick('🏠 Ana Menüye Dön')]);
    await continueProject(ctx);
    assert.deepEqual(itemsOf(prompter, 'Proje seç'), ['yeni — Faz 1 — Master frame', 'eski — Faz 1 — Master frame', 'Geri']);
    assert.equal(ctx.session.project, join(env.videosDir, 'yeni'));
  });
});

describe('batchBuild', () => {
  const readyProject = async (name) => {
    const { dir } = await project(name);
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    await writeFile(join(dir, 'audio', 'a.m4a'), '');
    const data = await readProject(dir);
    if (data.music && Array.isArray(data.music.tracks)) {
      data.music.tracks.forEach((t) => { t.status = 'completed'; t.file = 'a.m4a'; });
      data.music.completedCount = data.music.tracks.length;
    }
    data.clip = './videolar/in.mp4';
    await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));
    return dir;
  };
  const doneProject = async (name) => {
    const dir = await readyProject(name);
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), '');
    return dir;
  };
  const buildCall = (dir) => ['build.js', '--project', join(dir, 'project.json')];

  test('yalnızca hazır projeler seçilebilir; seçilenler liste sırasında derlenir; özet', async () => {
    const a = await readyProject('hazir-a');
    const b = await readyProject('hazir-b');
    await project('faz1-proje');

    const { ctx, calls, prompter, out } = makeCtx([picks('hazir-a', 'hazir-b'), true]);
    assert.equal(await batchBuild(ctx), true);

    const labels = itemsOf(prompter, 'Montaja hazır projeleri seç');
    assert.equal(labels.length, 2);
    for (const label of labels) assert.match(label, /^hazir-[ab] — Klip: \.\/videolar\/in\.mp4 · 1 parça$/);
    const order = labels.map((l) => (l.startsWith('hazir-a') ? a : b));
    assert.deepEqual(calls, order.map(buildCall));

    const text = out();
    assert.ok(text.includes('Montaja hazır olmayan 1 proje listelenmedi'));
    assert.ok(text.includes('2 proje sırayla derlenecek'));
    assert.ok(text.includes(`[1/2] ${labels[0].split(' — ')[0]}`));
    assert.ok(text.includes(`[başarılı]  hazir-a — ${join(a, 'out', 'final_ambient.mp4')}`));
    assert.ok(text.includes(`[başarılı]  hazir-b — ${join(b, 'out', 'final_ambient.mp4')}`));
  });

  test('çıktısı olan proje listede devre dışı, seçilemez', async () => {
    await readyProject('hazir');
    await doneProject('bitmis');
    const { ctx, prompter } = makeCtx([picks('bitmis')]);
    await assert.rejects(batchBuild(ctx), /devre dışı seçeneği gösteriyor: bitmis — çıktı var/);
    const question = prompter.questions.find((q) => q.kind === 'chooseMany');
    assert.equal(question.items.find((i) => i.label.startsWith('bitmis')).disabled, true);
  });
});

describe('runPanel', () => {
  test('Settings → Quit', async () => {
    const { ctx, out } = makeCtx([pick('Settings'), pick('Quit')]);
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
});

describe('multi-track music workflow in continueProject', () => {
  test('Track 01 algılanınca Track 02 aktifleşir, store güncellenir, 17/17 dolmadan montaj adımına geçilmez', async () => {
    const { dir } = await project('multi-track-test');
    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));

    // Sahte kullanıcının adımları:
    // 1. Track 01 için 'open' (klasör aç) -> State değişmez, 0/17 kalır
    // 2. 'refresh' yap (audio/ klasörüne audio1.mp3 atılınca) -> Track 01 completed (1/17)
    // 3. Track 02 için 'menu' seç -> Ana menüye dön
    const { ctx } = makeCtx([
      pick('open'),
      async () => {
        await writeFile(join(dir, 'audio', 'track01.mp3'), '');
        return pick('refresh');
      },
      pick('menu'),
    ]);

    ctx.session.project = dir;
    await continueProject(ctx);

    // project.json kontrol et
    const data = await readProject(dir);
    assert.equal(data.music.completedCount, 1);
    assert.equal(data.music.tracks[0].status, 'completed');
    assert.equal(data.music.tracks[1].status, 'pending');

    // Store state kontrolü: Müzik ekranında ve Track 02'ye geçilmiş olmalı!
    const storeState = ctx.store.getState();
    assert.equal(storeState.view, 'music');
    assert.equal(storeState.musicState.completedCount, 1);
    assert.equal(storeState.musicState.currentTrack.number, 2);
  });

  test('Finish Music & Continue seçildiğinde completed_by_user kaydedilir ve sonraki adıma geçilir', async () => {
    const { dir } = await project('finish-music-test');
    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    await writeFile(join(dir, 'audio', '01-Intro.mp3'), '');

    // "Bitir" ancak elde en az bir şarkı varken sunulur: ilk track tamamlanmış sayılır.
    const seed = await readProject(dir);
    seed.clip = './videolar/in.mp4';
    seed.video = { cropBottom: 150 };
    Object.assign(seed.music.tracks[0], { status: 'completed', file: '01-Intro.mp3' });
    seed.music.completedCount = 1;
    await writeFile(join(dir, 'project.json'), JSON.stringify(seed, null, 2));

    // Kullanıcı 1/17 track'te 'finish' seçip confirmation'a 'yes' diyor, build tamamlandıktan sonra publish adımında çıkıyor
    const { ctx } = makeCtx([
      pick('finish'),
      pick('yes'),
      pick('Ana Menüye Dön'),
    ]);

    ctx.session.project = dir;
    await continueProject(ctx);

    const data = await readProject(dir);
    assert.equal(data.music.status, 'completed_by_user');
    assert.equal(data.music.totalTracks, 17);
    assert.equal(data.music.tracks.filter((t) => t.status === 'pending').length, 16);

    // project-status ile nextStep kontrol et: Montaj yapıldığı için çıktı dosyası oluştu ve durum done oldu
    const status = await inspectProject(dir);
    assert.equal(nextStep(status).id, 'done');
  });

  test('Multi-Reference Visual Style seçildiğinde style-references adımına geçilir, Explorer açma state değiştirmez, görsel eklenince analiz başlatılır', async () => {
    const { dir } = await project('multi-ref-test');
    
    // Projeyi custom-generated style ile kur ve STYLE_BLOCK.txt'yi sil
    const projectJsonPath = join(dir, 'project.json');
    const projectData = JSON.parse(await readFile(projectJsonPath, 'utf8'));
    projectData.style = 'custom-generated';
    delete projectData.styleBlock;
    await writeFile(projectJsonPath, JSON.stringify(projectData, null, 2));
    const styleBlockFile = join(dir, 'STYLE_BLOCK.txt');
    const { rm } = await import('node:fs/promises');
    await rm(styleBlockFile, { force: true });

    let status = await inspectProject(dir);
    assert.equal(nextStep(status).id, 'style-references');

    // 1. Kullanıcı 'open' der (Explorer açılır, görseller henüz yok, state değişmez)
    // 2. 'refresh' der (klasörde henüz dosya yok, uyarır, step değişmez)
    // 3. Klasöre referans görseller eklenir (ref1.png, ref2.jpg)
    // 4. 'refresh' der (analiz çalışır, STYLE_BLOCK.txt ve project.json güncellenir)
    // 5. Sonraki faz1 adımında 'menu' ile çıkılır
    const mockGenerateContent = async () => ({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              styleBlock: {
                medium: 'Digital watercolor & ink',
                lines: 'Organic soft lines',
                palette: [
                  { hex: '#112233', role: 'Background' },
                  { hex: '#445566', role: 'Midtone' },
                  { hex: '#778899', role: 'Accent' },
                  { hex: '#AABBCC', role: 'Light' },
                  { hex: '#DDEEFF', role: 'Highlight' },
                ],
                light: 'Warm ambient glow',
                texture: 'Paper grain',
                contrast: 'Medium contrast',
                shading: 'Soft gradient',
              },
              suggestedAmbient: 'heavyRain',
              motionHints: ['Raindrops falling'],
            }),
          }],
        },
      }],
    });

    const { ctx, openedFolders } = makeCtx([
      pick('open'),
      pick('refresh'),
      async () => {
        await writeFile(join(dir, 'references', 'ref1.png'), 'fake-image-1');
        await writeFile(join(dir, 'references', 'ref2.jpg'), 'fake-image-2');
        return pick('refresh');
      },
      pick('menu'),
    ]);

    ctx.generateContentFn = mockGenerateContent;
    process.env.GEMINI_API_KEY = 'mock-key';

    ctx.session.project = dir;

    await continueProject(ctx);

    assert.deepEqual(openedFolders, [join(dir, 'references')]);

    const updatedData = await readProject(dir);
    assert.equal(updatedData.style, 'custom-generated');
    assert.ok(updatedData.styleBlock);
    assert.equal(updatedData.styleBlock.medium, 'Digital watercolor & ink');

    status = await inspectProject(dir);
    assert.equal(status.styleBlockExists, true);
    assert.equal(nextStep(status).id, 'faz1');
  });

  test('Müzik completed_by_user durumu: view "project" olur, sonraki adıma (faz3) geçer ve tekrar müzik ekranı açılmaz', async () => {
    const { dir } = await project();
    const statusBefore = await inspectProject(dir);
    
    // Simulate music data with 5 completed tracks out of 17 and status = 'completed_by_user'
    const projData = await readProject(dir);
    projData.music = {
      concept: 'Lofi Chill Beats',
      status: 'completed_by_user',
      completedCount: 5,
      totalTracks: 17,
      tracks: Array.from({ length: 17 }, (_, i) => ({
        number: i + 1,
        title: `Track ${i + 1}`,
        status: i < 5 ? 'completed' : 'pending',
      })),
    };
    await writeFile(join(dir, 'project.json'), JSON.stringify(projData, null, 2));

    // Master frame satisfies faz1 and audio tracks exist in audio/
    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'fake-master-frame');
    await mkdir(join(dir, 'audio'), { recursive: true });
    for (let i = 1; i <= 5; i++) {
      await writeFile(join(dir, 'audio', `track_${i}.mp3`), 'fake-audio');
    }

    let inspected = await inspectProject(dir);
    assert.ok(inspected.master);
    assert.equal(nextStep(inspected).id, 'faz3'); // Music is recognized as completed, step moves to faz3!

    // Call continueProject and immediately choose menu when it reaches faz3
    const { ctx } = makeCtx([pick('menu')]);
    ctx.session.project = dir;

    await continueProject(ctx);

    // Verify snapshot state in store
    const snap = ctx.store.getState();
    assert.equal(snap.view, 'project'); // Store view set back to 'project'
    assert.equal(snap.projectStatus.musicStatus, 'completed_by_user');
    assert.equal(snap.projectStatus.musicCompletedCount, 5);

    // Verify DashboardView label formatting
    const viewOutput = DashboardView({ snap, size: { columns: 80, rows: 24 } });
    assert.ok(viewOutput);

    // Ensure 17 total tracks and 12 pending tracks are untouched in project.json
    const reloaded = await readProject(dir);
    assert.equal(reloaded.music.tracks.length, 17);
    assert.equal(reloaded.music.tracks.filter((t) => t.status === 'pending').length, 12);
  });

  test('Done aşamasında view "done" olur ve DashboardView tek ve temiz bir layout çizer', async () => {
    const { dir } = await project();
    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'fake-master');
    await mkdir(join(dir, 'videolar'), { recursive: true });
    await writeFile(join(dir, 'videolar', 'clip.mp4'), 'fake-clip');
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'audio', 'track1.mp3'), 'fake-audio');
    await mkdir(join(dir, 'out'), { recursive: true });
    await writeFile(join(dir, 'out', 'final_ambient.mp4'), 'fake-video');
    await writeFile(join(dir, 'out', 'tracklist.txt'), '0:00 Track 1\n2:49 Track 2');

    const status = await inspectProject(dir);
    assert.equal(nextStep(status).kind, 'done');

    const { ctx } = makeCtx([pick('menu')]);
    ctx.session.project = dir;

    await continueProject(ctx);

    const snap = ctx.store.getState();
    assert.equal(snap.view, 'done');
    assert.equal(snap.doneState.name, status.name);
    assert.ok(snap.doneState.tracklist.includes('0:00 Track 1'));

    const viewOutput = DashboardView({ snap, size: { columns: 80, rows: 24 } });
    assert.ok(viewOutput);
  });

  test('Watermark sorusunda "Hayır" seçilirse project.json video.cropBottom = 0 olarak kaydedilir', async () => {
    const { dir } = await project('watermark-no-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'clip1.mp4'), '');
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'audio', 'a.mp3'), '');
    const dataBefore = await readProject(dir);
    dataBefore.music = { status: 'completed_by_user', tracks: [] };
    await writeFile(join(dir, 'project.json'), JSON.stringify(dataBefore, null, 2));

    const { ctx } = makeCtx([pick('no'), pick('Ana Menüye Dön')]);
    ctx.session.project = dir;

    await continueProject(ctx);

    const data = await readProject(dir);
    assert.equal(data.video.cropBottom, 0);
  });

  test('Watermark sorusunda "Evet" seçilirse varsayılan cropBottom (150) korunur', async () => {
    const { dir } = await project('watermark-yes-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'clip2.mp4'), '');
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'audio', 'a.mp3'), '');
    const dataBefore = await readProject(dir);
    dataBefore.music = { status: 'completed_by_user', tracks: [] };
    await writeFile(join(dir, 'project.json'), JSON.stringify(dataBefore, null, 2));

    const { ctx } = makeCtx([pick('yes'), pick('Ana Menüye Dön')]);
    ctx.session.project = dir;

    await continueProject(ctx);

    const data = await readProject(dir);
    assert.equal(data.video.cropBottom, 150);
  });

  test('Müzik seçiminde native dialog ile dosya seçildiğinde dosya proje audio/ klasörüne kopyalanır ve proje audio/ içindeki dosya adı saklanır', async () => {
    const { dir } = await project('native-picker-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));

    const fakeSourceDir = join(env.base, 'temp-music');
    await mkdir(fakeSourceDir, { recursive: true });
    const fakeAudio1 = join(fakeSourceDir, 'Night Drive.mp3');
    await writeFile(fakeAudio1, 'audio-content');

    const { ctx } = makeCtx([pick('Select Audio Files'), pick('Ana Menüye Dön')]);
    ctx.pickAudioFilesFn = async () => [fakeAudio1];
    ctx.session.project = dir;

    await continueProject(ctx);

    const reloaded = await readProject(dir);
    assert.equal(reloaded.music.tracks[0].file, 'Night Drive.mp3');

    const audioFiles = await readdir(join(dir, 'audio')).catch(() => []);
    assert.ok(audioFiles.includes('Night Drive.mp3'));
  });

  test('Çakışan isimde müzik kopyalanırsa güvenli duplicate ismi (Night Drive (1).mp3) üretilir ve kopyalanır', async () => {
    const { dir } = await project('native-picker-duplicate-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));
    await writeFile(join(dir, 'audio', 'Night Drive.mp3'), 'existing-content');

    const fakeSourceDir = join(env.base, 'temp-music-dup');
    await mkdir(fakeSourceDir, { recursive: true });
    const fakeAudioDup = join(fakeSourceDir, 'Night Drive.mp3');
    await writeFile(fakeAudioDup, 'new-content');

    const { ctx } = makeCtx([pick('Select Audio Files'), pick('Ana Menüye Dön')]);
    ctx.pickAudioFilesFn = async () => [fakeAudioDup];
    ctx.session.project = dir;

    await continueProject(ctx);

    const audioFiles = await readdir(join(dir, 'audio')).catch(() => []);
    assert.ok(audioFiles.includes('Night Drive.mp3'));
    assert.ok(audioFiles.includes('Night Drive (1).mp3'));
  });

  test('Müzik seçiminde native dialog iptal edilirse (null) state değişmez ve aynı müzik ekranında kalınır', async () => {
    const { dir } = await project('native-picker-cancel-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));

    const { ctx, prompter } = makeCtx([pick('Select Audio Files'), pick('Ana Menüye Dön')]);
    ctx.pickAudioFilesFn = async () => null;
    ctx.session.project = dir;

    await continueProject(ctx);

    const reloaded = await readProject(dir);
    assert.equal(reloaded.music.tracks[0].status, 'pending');
    assert.equal(reloaded.music.tracks[0].file ?? null, null);

    const statusAfter = await inspectProject(dir);
    assert.equal(statusAfter.audioCount, 0);

    const questions = prompter.questions.map((q) => q.question);
    assert.ok(!questions.some((q) => q.includes('START PRODUCTION')));
  });

  test('Müzik ekranı: Select Audio -> Cancel -> Select Audio again -> MP3 seçimi sonrası akış devam eder', async () => {
    const { dir } = await project('native-picker-retry-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));

    const fakeSourceDir = join(env.base, 'temp-retry-music');
    await mkdir(fakeSourceDir, { recursive: true });
    const fakeAudio = join(fakeSourceDir, 'Chill Track.mp3');
    await writeFile(fakeAudio, 'audio-data');

    let callsCount = 0;
    const { ctx } = makeCtx([
      pick('Select Audio Files'), // 1. Deneme -> Cancel
      pick('Select Audio Files'), // 2. Deneme -> Dosya seç
      pick('Ana Menüye Dön'),
    ]);

    ctx.pickAudioFilesFn = async () => {
      callsCount++;
      if (callsCount === 1) return null; // 1. seçim Cancel
      return [fakeAudio]; // 2. seçim Başarılı
    };

    ctx.session.project = dir;
    await continueProject(ctx);

    const reloaded = await readProject(dir);
    assert.equal(reloaded.music.tracks[0].status, 'completed');
    assert.equal(reloaded.music.tracks[0].file, 'Chill Track.mp3');

    const audioFiles = await readdir(join(dir, 'audio')).catch(() => []);
    assert.ok(audioFiles.includes('Chill Track.mp3'));
  });

  test('Native picker ile aynı anda birden fazla (2+) audio seçildiğinde tümü audio/ klasörüne kopyalanır ve track status güncellenir', async () => {
    const { dir } = await project('multi-audio-pick-test');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'videolar', 'in.mp4'), '');
    const p = await readProject(dir);
    p.clip = './videolar/in.mp4';
    p.video = { cropBottom: 150 };
    await writeFile(join(dir, 'project.json'), JSON.stringify(p, null, 2));

    const fakeSourceDir = join(env.base, 'temp-multi-music');
    await mkdir(fakeSourceDir, { recursive: true });
    const fakeAudio1 = join(fakeSourceDir, 'Track1.mp3');
    const fakeAudio2 = join(fakeSourceDir, 'Track2.wav');
    const fakeAudio3 = join(fakeSourceDir, 'Track3.flac');
    await writeFile(fakeAudio1, 'audio-1');
    await writeFile(fakeAudio2, 'audio-2');
    await writeFile(fakeAudio3, 'audio-3');

    const { ctx } = makeCtx([pick('Select Audio Files'), pick('Ana Menüye Dön')]);
    ctx.pickAudioFilesFn = async () => [fakeAudio1, fakeAudio2, fakeAudio3];
    ctx.session.project = dir;

    await continueProject(ctx);

    const reloaded = await readProject(dir);
    assert.equal(reloaded.music.tracks[0].status, 'completed');
    assert.equal(reloaded.music.tracks[0].file, 'Track1.mp3');
    assert.equal(reloaded.music.tracks[1].status, 'completed');
    assert.equal(reloaded.music.tracks[1].file, 'Track2.wav');
    assert.equal(reloaded.music.tracks[2].status, 'completed');
    assert.equal(reloaded.music.tracks[2].file, 'Track3.flac');

    const audioFiles = await readdir(join(dir, 'audio')).catch(() => []);
    assert.ok(audioFiles.includes('Track1.mp3'));
    assert.ok(audioFiles.includes('Track2.wav'));
    assert.ok(audioFiles.includes('Track3.flac'));
  });

  test('newProject: Müzik dosyası seçiminde Cancel yapıldığında START PRODUCTION? ekranına geçilmez, Müzik Kaynağı menüsünde kalınır', async () => {
    const { ctx, prompter } = makeCtx([
      'video-cancel-test',
      pick('anime-cel'),
      picks('gentleRain'),
      '2:17 AM',
      '17',
      pick('Select Audio Files'), // File picker açılır -> Cancel
      pick('Default music'),       // Menüde kalınır -> Default music seçilir
      false,                       // START PRODUCTION -> Hayır
    ]);

    ctx.pickAudioFilesFn = async () => null; // Cancel

    assert.equal(await newProject(ctx), false);

    const questions = prompter.questions.map((q) => q.question);
    const firstMusicIdx = questions.findIndex((q) => q === 'Music Source:');
    const startProdIdx = questions.findIndex((q) => q.includes('START PRODUCTION'));

    assert.ok(firstMusicIdx >= 0, 'Music Source sorusu sorulmalı');
    assert.ok(startProdIdx > firstMusicIdx, 'START PRODUCTION sorusu Müzik Seçiminden sonra gelmeli');
    const musicCount = questions.filter((q) => q === 'Music Source:').length;
    assert.equal(musicCount, 2, 'Cancel sonrası Music Source sorusu tekrar sorulmalı');
  });
});



describe('Auto Watch (İndirilenler → audio/)', () => {
  /** Master hazır, iki bekleyen track'li proje + sahte İndirilenler klasörü. */
  async function musicProject() {
    const { dir } = await project('auto-watch');
    const data = await readProject(dir);
    data.music = {
      concept: 'Test', status: 'in_progress', completedCount: 0, totalTracks: 2,
      tracks: [
        { number: 1, title: 'Intro', status: 'pending', prompt: 'p1' },
        { number: 2, title: 'Outro', status: 'pending', prompt: 'p2' },
      ],
    };
    await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    const downloads = fakeDownloads;
    await writeFile(join(downloads, 'eski.mp3'), 'önceden inmiş');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(join(downloads, 'eski.mp3'), hourAgo, hourAgo);
    return { dir, downloads };
  }

  test('iki indirme sırayla iki track\'i tamamlar: taşınır (NN-ad), yarım indirme beklenir, eski dosyaya dokunulmaz', async () => {
    const { dir, downloads } = await musicProject();
    const { ctx, out } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        afterStart: async () => {
          await writeFile(join(downloads, 'Quiet Moments.mp3'), 'a');
          await writeFile(join(downloads, 'İkinci Şarkı.mp3.crdownload'), 'b');
        },
        onPoll: async (n) => {
          if (n === 5) await rename(join(downloads, 'İkinci Şarkı.mp3.crdownload'), join(downloads, 'İkinci Şarkı.mp3'));
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.deepEqual((await readdir(join(dir, 'audio'))).sort(), ['01-Quiet-Moments.mp3', '02-İkinci-Şarkı.mp3']);
    assert.deepEqual(await readdir(downloads), ['eski.mp3'], 'taşındı (kopyalanmadı), eski dosya yerinde');
    const music = (await readProject(dir)).music;
    assert.deepEqual(music.tracks.map((t) => [t.status, t.file]), [['completed', '01-Quiet-Moments.mp3'], ['completed', '02-İkinci-Şarkı.mp3']]);
    assert.equal(music.status, 'completed');
    assert.ok(out().includes('[✓ Auto Watch Bitti]'));
    assert.equal(ctx.store.getState().onKey, null, 'tuş kancası kaldırıldı');
  });

  test('Auto Watch açılmadan önce (son 15 dk) inmiş mp3\'ler indirilme sırasıyla alınır; 1 saatlik dosyaya dokunulmaz', async () => {
    const { dir, downloads } = await musicProject();
    await writeFile(join(downloads, 'Ikinci.mp3'), 'b');
    await writeFile(join(downloads, 'Birinci.mp3'), 'a');
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
    await utimes(join(downloads, 'Birinci.mp3'), minutesAgo(10), minutesAgo(10));
    await utimes(join(downloads, 'Ikinci.mp3'), minutesAgo(2), minutesAgo(2));

    const { ctx } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('menu')]);
    Object.assign(ctx, { downloadsDir: downloads, downloadPollMs: 1, createDownloadWatcherFn: watcherWith({}) });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.deepEqual((await readProject(dir)).music.tracks.map((t) => t.file), ['01-Birinci.mp3', '02-Ikinci.mp3']);
    assert.deepEqual(await readdir(downloads), ['eski.mp3']);
  });

  test('süre seçimi: "Son 5 dakika" 10 dk önce ineni almaz; .m4a alınır, [site] ve (1) ekleri addan atılır', async () => {
    const { dir, downloads } = await musicProject();
    const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
    await writeFile(join(downloads, 'Eski Deneme.m4a'), 'a');
    await utimes(join(downloads, 'Eski Deneme.m4a'), minutesAgo(10), minutesAgo(10));
    await writeFile(join(downloads, '静かな朝の練習 [usesuno.com] (1).m4a'), 'b');
    await utimes(join(downloads, '静かな朝の練習 [usesuno.com] (1).m4a'), minutesAgo(2), minutesAgo(2));

    const { ctx, prompter } = makeCtx([pick('watch'), pick('Son 5 dakika'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        onPoll: async (n) => {
          if (n >= 6) ctx.store.getState().onKey?.('', { escape: true });
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.deepEqual(itemsOf(prompter, 'ne kadar önce'), ['Son 5 dakika', 'Son 10 dakika', 'Son 15 dakika', 'Geri']);
    const music = (await readProject(dir)).music;
    assert.deepEqual(music.tracks.map((t) => [t.status, t.file]), [['completed', '01-静かな朝の練習.m4a'], ['pending', undefined]]);
    assert.deepEqual((await readdir(downloads)).sort(), ['Eski Deneme.m4a', 'eski.mp3']);
  });

  test('süre sorusunda Geri → izleme başlamaz, menü tekrar gelir', async () => {
    const { dir, downloads } = await musicProject();
    let started = false;
    const { ctx, prompter } = makeCtx([pick('watch'), pick('Geri'), pick('menu')]);
    Object.assign(ctx, { downloadsDir: downloads, createDownloadWatcherFn: () => { started = true; throw new Error('başlamamalı'); } });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });
    assert.equal(started, false);
    assert.equal(prompter.questions.filter((q) => q.question.startsWith('TRACK 01 READY')).length, 2);
  });

  test('B tuşu: izleme durur, onay sorulur; "Yes" → müzik aşaması eksik track\'lerle biter, sonraki adıma geçilir', async () => {
    const { dir, downloads } = await musicProject();
    const { ctx, out, prompter } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('Yes, Continue'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        afterStart: () => writeFile(join(downloads, 'Tek Sarki.mp3'), 'a'),
        onPoll: async (n) => {
          if (n === 5) assert.equal(ctx.store.getState().onKey('B', { ctrl: false, meta: false }), true);
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    const music = (await readProject(dir)).music;
    assert.equal(music.status, 'completed_by_user');
    assert.equal(music.completedCount, 1);
    assert.deepEqual(music.tracks.map((t) => t.status), ['completed', 'pending']);
    assert.ok(out().includes('müzik aşamasını bitirme onayı soruluyor'));
    assert.ok(itemsOf(prompter, '1 / 2 tracks completed'), 'onay sorusu B ile açıldı');
    assert.ok(prompter.questions.some((q) => q.question.startsWith('CAMERA / VIDEO CLIP READY')), 'sonraki adım (klip)');
    assert.equal(ctx.store.getState().onKey, null);
  });

  test('B tuşu + "No" → müzik aşaması sürer, track menüsüne dönülür; Ctrl+b tetiklemez', async () => {
    const { dir, downloads } = await musicProject();
    const { ctx, prompter } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('No, Keep Generating'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        afterStart: () => writeFile(join(downloads, 'Tek Sarki.mp3'), 'a'),
        onPoll: async (n) => {
          if (n === 2) assert.equal(ctx.store.getState().onKey('b', { ctrl: true, meta: false }), false);
          if (n === 5) ctx.store.getState().onKey('b', { ctrl: false, meta: false });
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    const music = (await readProject(dir)).music;
    assert.equal(music.status, 'in_progress');
    // Track 01 inen dosyayla tamamlandı; "No" sonrası sıradaki track'in menüsüne dönülür.
    assert.equal(prompter.questions.filter((q) => q.question.startsWith('TRACK 02 READY')).length, 1);
  });

  test('hiç şarkı yokken B çalışmaz (eylem kutusu kapalı); ilk track gelince açılır', async () => {
    const { dir, downloads } = await musicProject();
    const { ctx, out, prompter } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('Yes, Continue'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        onPoll: async (n) => {
          if (n === 2) {
            assert.equal(ctx.store.getState().actionHint.enabled, false, 'şarkı yokken kutu kapalı');
            assert.equal(ctx.store.getState().onKey('b', { ctrl: false, meta: false }), true);
            assert.ok(out().includes('Henüz şarkı eklenmedi'), 'kullanıcıya neden çalışmadığı yazılır');
          }
          if (n === 3) await writeFile(join(downloads, 'Tek Sarki.mp3'), 'a');
          if (n === 6) {
            assert.equal(ctx.store.getState().actionHint.enabled, true, 'ilk şarkıdan sonra kutu açık');
            ctx.store.getState().onKey('b', { ctrl: false, meta: false });
          }
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    const music = (await readProject(dir)).music;
    assert.equal(music.status, 'completed_by_user');
    assert.equal(music.completedCount, 1);
    assert.equal(ctx.store.getState().actionHint, null, 'izleme bitince kutu kalkar');
    assert.ok(prompter.questions.some((q) => q.question.startsWith('CAMERA / VIDEO CLIP READY')), 'sonraki adım (klip)');
  });

  test('hiç şarkı yokken track menüsünde "Finish Music & Continue" görünmez', async () => {
    const { dir } = await musicProject();
    const { ctx, prompter } = makeCtx([pick('menu')]);
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    const trackMenu = prompter.questions.find((q) => q.question.startsWith('TRACK 01 READY'));
    assert.ok(trackMenu, 'track menüsü açıldı');
    assert.equal(trackMenu.items.some((it) => it.value === 'finish'), false);
  });

  test('tek Esc durdurmaz (alt-tab\'ın tetiklediği sahte Esc\'e karşı); art arda iki Esc durdurur', async () => {
    const { dir, downloads } = await musicProject();
    const { ctx, out, prompter } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        onPoll: async (n) => {
          if (n === 2) {
            assert.equal(ctx.store.getState().onKey('', { escape: true }), true);
            assert.ok(out().includes('Esc\'e tekrar bas'));
            assert.equal(ctx.store.getState().footer.includes('Auto Watch'), true, 'tek Esc\'te izleme sürüyor');
          }
          if (n === 3) assert.equal(ctx.store.getState().onKey('', { escape: true }), true);
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.ok(out().includes('[Auto Watch Durdu]'));
    assert.deepEqual((await readProject(dir)).music.tracks.map((t) => t.status), ['pending', 'pending']);
    assert.equal(ctx.store.getState().onKey, null);
    assert.equal(ctx.store.getState().footer, '');
    assert.equal(prompter.questions.filter((q) => q.question.startsWith('TRACK 01 READY')).length, 2, 'iki Esc sonrası menü');
  });

  test('audio/\'da aynı ad varsa taşınan dosya "(1)" alır, var olan dosyanın üzerine yazılmaz', async () => {
    const { dir, downloads } = await musicProject();
    await mkdir(join(dir, 'audio'), { recursive: true });
    await writeFile(join(dir, 'audio', '02-Intro.mp3'), 'eski');
    const data = await readProject(dir);
    Object.assign(data.music.tracks[0], { status: 'completed', file: '02-Intro.mp3' });
    data.music.completedCount = 1;
    await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));

    const { ctx } = makeCtx([pick('watch'), pick('Son 15 dakika'), pick('menu')]);
    Object.assign(ctx, {
      downloadsDir: downloads,
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({ afterStart: () => writeFile(join(downloads, 'Intro.mp3'), 'yeni') }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.equal((await readProject(dir)).music.tracks[1].file, '02-Intro (1).mp3');
    assert.equal(await readFile(join(dir, 'audio', '02-Intro.mp3'), 'utf8'), 'eski');
    assert.equal(await readFile(join(dir, 'audio', '02-Intro (1).mp3'), 'utf8'), 'yeni');
  });
});

describe('Auto Watch (İndirilenler → resimler/ ve videolar/)', () => {
  /** Müziksiz proje: akış doğrudan faz1'den (master frame) başlar. */
  async function visualProject(name) {
    const { dir } = await project(name);
    const data = await readProject(dir);
    delete data.music;
    await writeFile(join(dir, 'project.json'), JSON.stringify(data, null, 2));
    return dir;
  }

  test('faz1: İndirilenler\'e inen görsel resimler/MASTER.png olarak taşınır ve adım ilerler', async () => {
    const dir = await visualProject('watch-master');
    const { ctx, out } = makeCtx([
      pick('⏳ [ Auto Watch ]'),
      pick('Son 15 dakika'),
      async () => {
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        await writeFile(join(dir, 'audio', 'a.m4a'), '');
        return pick('Default music');
      },
      pick('Son 15 dakika'),
      pick('no'),
      pick('Ana Menüye Dön'),
    ]);
    // Sonraki adımın (audio) Auto Watch'ı da izleyici başlatır; görsel yalnızca ilkinde insin.
    let dropped = false;
    Object.assign(ctx, {
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        afterStart: async () => {
          if (dropped) return;
          dropped = true;
          await writeFile(join(fakeDownloads, 'sahne [midjourney] (1).png'), 'görsel');
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.equal(await readFile(join(dir, 'resimler', 'MASTER.png'), 'utf8'), 'görsel');
    assert.deepEqual(await readdir(fakeDownloads), [], 'dosya taşınır, İndirilenler\'de kalmaz');
    assert.ok(out().includes('[✓ İndirilen Dosya Alındı]'));
    assert.equal(ctx.store.getState().onKey, null);
    assert.equal(ctx.store.getState().actionHint, null);
  });

  test('faz3: İndirilenler\'e inen mp4 videolar/ altına taşınır, ad temizlenir ve klip bağlanır', async () => {
    const dir = await visualProject('watch-clip');
    await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
    await writeFile(join(dir, 'audio', 'a.m4a'), '');
    const { ctx } = makeCtx([
      pick('⏳ [ Auto Watch ]'),
      pick('Son 15 dakika'),
      pick('no'),
      pick('Ana Menüye Dön'),
    ]);
    Object.assign(ctx, {
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        afterStart: () => writeFile(join(fakeDownloads, 'Kamera Klip [kling] (1).mp4'), 'klip'),
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.equal(await readFile(join(dir, 'videolar', 'Kamera-Klip.mp4'), 'utf8'), 'klip');
    assert.equal((await readProject(dir)).clip, './videolar/Kamera-Klip.mp4');
  });

  test('faz1: iki Esc izlemeyi durdurur, menüye dönülür (tek Esc durdurmaz)', async () => {
    const dir = await visualProject('watch-escape');
    const { ctx, out, prompter } = makeCtx([
      pick('⏳ [ Auto Watch ]'),
      pick('Son 15 dakika'),
      pick('Ana Menüye Dön'),
    ]);
    Object.assign(ctx, {
      downloadPollMs: 1,
      createDownloadWatcherFn: watcherWith({
        onPoll: async (n) => {
          if (n === 2) {
            assert.equal(ctx.store.getState().actionHint.key, 'Esc Esc', 'kısayol ekranda görünür');
            assert.equal(ctx.store.getState().onKey('', { escape: true }), true);
            assert.ok(out().includes('Esc\'e tekrar bas'));
            assert.ok(ctx.store.getState().footer.includes('Auto Watch'), 'tek Esc\'te izleme sürüyor');
          }
          if (n === 3) ctx.store.getState().onKey('', { escape: true });
        },
      }),
    });
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 1 });

    assert.ok(out().includes('[Auto Watch Durdu]'));
    assert.equal(ctx.store.getState().onKey, null);
    assert.equal(ctx.store.getState().footer, '');
    assert.equal(prompter.questions.filter((q) => q.question.startsWith('MASTER FRAME READY')).length, 2);
  });
});
