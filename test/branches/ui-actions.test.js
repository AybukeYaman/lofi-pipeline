/**
 * Panel akışları — sahte prompter (değer yanıtları), komutları kaydeden sahte
 * run, geçici videolar/ambient/styles klasörleri. Gerçek komut çalıştırılmaz;
 * new-video gerektiğinde sahte run projeyi runNewVideo ile kurar.
 * Prompter uygulamasından (readline/enquirer) bağımsızdır.
 */

import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

import { runPanel } from '../../lofi.js';
import { parseCli as parseNewVideoCli, runNewVideo } from '../../new-video.js';
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
  const ctx = { prompter, run, store, session: createSession(), ...env };
  return { ctx, calls, prompter, out: () => prompter.output() };
}

const project = (name = 'v') => runNewVideo({ videoName: name, styleName: 'anime-cel', ...env });
const readProject = async (dir) => JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
const itemsOf = (prompter, questionPart) =>
  prompter.questions.find((q) => q.question.includes(questionPart))?.items.map((i) => i.label);

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
    const { ctx } = makeCtx([
      async () => {
        await writeFile(join(dir, 'resimler', 'MASTER.png'), '');
        return pick('⏳ [ Auto Watch ]');
      },
      async () => {
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        await writeFile(join(dir, 'audio', 'a.m4a'), '');
        return pick('watch');
      },
      pick('no'),
      pick('Ana Menüye Dön'),
    ]);
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 10 });

    assert.equal((await readProject(dir)).clip, './videolar/in.mp4');
  });

  test('Klasörü Aç (dosya yok) → bekleme ekranında kalır, Yenile (dosya var) → otomatik ilerler', async () => {
    const { dir } = await project('bekleme-testi');
    const { ctx, out } = makeCtx([
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
      // Audio: Müzik eklendikten sonra Yenile seçilir
      async () => {
        await writeFile(join(dir, 'audio', 'track1.mp3'), '');
        return pick('refresh');
      },
      // FAZ 3: Klasörü Aç seçilir ama dosya eklenmez
      pick('open'),
      // FAZ 3: Klip eklendikten sonra Yenile seçilir
      async () => {
        await writeFile(join(dir, 'videolar', 'in.mp4'), '');
        return pick('refresh');
      },
      pick('no'),
      pick('Ana Menüye Dön'),
    ]);
    ctx.session.project = dir;
    await continueProject(ctx, null, { pollMs: 10 });

    const outputText = out();
    assert.ok(outputText.includes('[📂 Klasör Açıldı]'));
    assert.ok(outputText.includes('[✓ Master Görseli Algılandı]'));
    assert.ok(outputText.includes('Detected') || outputText.includes('Müzik Dosyası Algılandı'));
    assert.ok(outputText.includes('[✓ Video Klip Algılandı & Bağlandı]'));
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
  test('Track 01 algılanınca Track 02 aktifleşir, store güncellenir, 17/17 dolmadan klip adımına geçilmez', async () => {
    const { dir } = await project('multi-track-test');
    await writeFile(join(dir, 'resimler', 'MASTER.PNG'), '');

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

    // Kullanıcı 15/17 track'te 'finish' seçip confirmation'a 'yes' diyor, sonraki faz3 adımında 'menu' diyerek çıkıyor
    const { ctx } = makeCtx([
      pick('finish'),
      pick('yes'),
      pick('menu'),
    ]);

    ctx.session.project = dir;
    await continueProject(ctx);

    const data = await readProject(dir);
    assert.equal(data.music.status, 'completed_by_user');
    assert.equal(data.music.totalTracks, 17);
    assert.equal(data.music.tracks.filter((t) => t.status === 'pending').length, 17);

    // project-status ile nextStep kontrol et: Artık audio değil faz3 bekleniyor
    const status = await inspectProject(dir);
    assert.equal(nextStep(status).id, 'faz3');
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

    const { ctx } = makeCtx([
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


