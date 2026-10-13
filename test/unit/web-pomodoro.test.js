/**
 * GET/PUT /api/projects/:id/pomodoro — Pomodoro ayarı ve MONTAJ ÖNCESİ doğrulama.
 *
 * Neden var: spec'in en önemli maddesi "montaja geçmeden önce uyar". Burada
 * doğrulanan şey, kullanıcı Başlat'a basmadan ekranda doğru sayıların çıkması
 * ve doğrulama geçmediğinde montajın HİÇ başlamaması. ffprobe sahte: parça
 * süreleri dosya adından okunuyor, gerçek ses üretmeye gerek yok.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  ApiError, getAsset, getLabels, getPomodoro, getProject, startBuild, updatePomodoro,
} from '../../server/project-api.js';
import { createWebServer } from '../../server/web-server.js';
import { setProjectClip } from '../../prep/project-file.js';

let base;
let videosDir;
let server;
let url;

/** Sahte ffprobe: süre dosya adındaki saniyeden ("t-600.m4a" → 600 sn). */
async function fakeProbe(path) {
  const match = /t-(\d+(?:\.\d+)?)/.exec(path);
  if (!match) throw new Error(`ölçülemeyen dosya: ${path}`);
  return { duration: Number(match[1]), hasAudio: true };
}

const options = () => ({ videosDir, probeFn: fakeProbe });

/** 50/10 durum listesi (API gövdesi): eski preset anahtarı artık yazılmıyor. */
const CLASSIC = [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }];
const withBreak = (visual) => [CLASSIC[0], { ...CLASSIC[1], ...(visual === undefined ? {} : { visual }) }];

/** Toplamı `totalSeconds` olan `count` parçalık bir müzik seçimi. */
function tracksFor(totalSeconds, count = 4) {
  const each = totalSeconds / count;
  return Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(2, '0')}-t-${each}.m4a`);
}

async function writeProject(name, { project = {}, audio = [] } = {}) {
  const dir = join(videosDir, name);
  await mkdir(join(dir, 'audio'), { recursive: true });
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    clip: './videolar/in.mp4', audioDir: './audio', video: { cropBottom: 150 }, ...project,
  }, null, 2));
  for (const file of audio) await writeFile(join(dir, 'audio', file), `audio:${file}`);
  return dir;
}

const readProjectJson = async (name) =>
  JSON.parse(await readFile(join(videosDir, name, 'project.json'), 'utf8'));

before(async () => {
  base = await mkdtemp(join(tmpdir(), 'lofi-web-pomodoro-'));
  videosDir = join(base, 'videolar');
  await mkdir(videosDir);

  server = createWebServer({
    projectApi: {
      getPomodoro: (id) => getPomodoro(id, options()),
      updatePomodoro: (id, body) => updatePomodoro(id, body, options()),
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

describe('GET /api/projects/:id/pomodoro', () => {
  test('Pomodoro kapalıyken ayar yok, doğrulama engel çıkarmaz', async () => {
    await writeProject('off', { audio: tracksFor(1000) });
    const res = await getPomodoro('off', options());

    assert.equal(res.enabled, false);
    assert.equal(res.settings, null);
    assert.equal(res.validation.ok, true);
    // Varsayılanlar kapalıyken de dönüyor; hazır düzenler artık /api/pomodoro-sets'te.
    assert.equal('presets' in res, false);
    assert.deepEqual(res.defaults.statuses.map((s) => [s.name, s.minutes]), [['STUDY', 50], ['BREAK', 10]]);
  });

  test('Test 1 — müzik tam oturuyorsa doğrulama geçer', async () => {
    await writeProject('exact', {
      project: { pomodoro: { enabled: true, preset: '50/10', rounds: 4 } },
      audio: tracksFor(232 * 60),
    });
    const res = await getPomodoro('exact', options());

    assert.equal(res.enabled, true);
    assert.equal(res.validation.ok, true);
    assert.equal(res.validation.comparison.status, 'exact');
    assert.equal(res.validation.timeline.totalMinutes, 232);
    assert.equal(res.music.totalSeconds, 232 * 60);
  });

  test('Test 2 — fazla müzik sayılarla ve kırpma planıyla raporlanır', async () => {
    await writeProject('excess', {
      project: { pomodoro: { enabled: true, preset: '50/10', rounds: 4 } },
      audio: tracksFor(245 * 60),
    });
    const res = await getPomodoro('excess', options());

    // Fazla müzik engel değil: uyarı + otomatik kırpma planı.
    assert.equal(res.validation.ok, true);
    assert.equal(Object.hasOwn(res.validation, 'needsTrimConfirmation'), false);
    assert.ok(res.validation.warnings.some((w) => w.includes('otomatik kırpılacak')));
    assert.equal(res.validation.comparison.excessSeconds, 13 * 60);
    assert.ok(res.validation.message.includes('Pomodoro timeline: 232:00'));
    assert.ok(res.validation.message.includes('Müzik toplamı: 245:00'));
    assert.ok(res.validation.message.includes('Fazla: 13:00'));
    // Kırpmanın ne yapacağı Başlat'tan ÖNCE görünür.
    assert.equal(res.validation.trim.trimmedSeconds, 13 * 60);
  });

  test('Test 3 — eksik müzik engel değil, uyarıdır', async () => {
    await writeProject('short', {
      project: { pomodoro: { enabled: true, preset: '50/10', rounds: 4 } },
      audio: tracksFor(219.5 * 60),
    });
    const res = await getPomodoro('short', options());

    assert.equal(res.validation.ok, true);
    assert.equal(res.validation.comparison.shortSeconds, 12.5 * 60);
    assert.ok(res.validation.message.includes('Eksik: 12:30'));
    assert.ok(res.validation.warnings.some((w) => w.includes('Ambiance')));
  });

  test('Test 4 — 30/10 × 6 de 232 dakika timeline üretir (2 dk GET READY dahil, son BREAK yok)', async () => {
    await writeProject('thirty', {
      project: { pomodoro: { enabled: true, preset: '30/10', rounds: 6 } },
      audio: tracksFor(232 * 60),
    });
    const res = await getPomodoro('thirty', options());

    assert.equal(res.validation.timeline.totalMinutes, 232);
    assert.equal(res.validation.timeline.sessions.length, 12);
    assert.equal(res.validation.ok, true);
  });

  test('parça sırası project.json "order" alanından gelir', async () => {
    await writeProject('ordered', {
      project: {
        order: ['uzun-t-1200.m4a', 'kisa-t-300.m4a'],
        pomodoro: { enabled: true, workMinutes: 10, breakMinutes: 5, rounds: 1 },
      },
      audio: ['kisa-t-300.m4a', 'uzun-t-1200.m4a'],
    });
    const res = await getPomodoro('ordered', options());

    // 12 dk timeline (2 dk GET READY + 10 dk STUDY; son BREAK düşer): önce 20 dk'lık "uzun" geliyor, 12 dk'ya
    // kırpılıyor, "kisa" hiç kullanılmıyor. Sıra yanlış okunsaydı kırpma da yanlış olurdu.
    assert.deepEqual(res.validation.trim.tracks.map((t) => t.usedDuration), [720, 0]);
    assert.equal(res.validation.trim.droppedCount, 1);
  });

  test('bozuk pomodoro bloğu sessizce yok sayılmaz', async () => {
    await writeProject('broken', {
      project: { pomodoro: { enabled: true, preset: '25/5' } },
      audio: tracksFor(600),
    });
    const res = await getPomodoro('broken', options());
    assert.ok(res.problems.some((p) => p.includes('pomodoro.preset')));
  });
});

describe('PUT /api/projects/:id/pomodoro', () => {
  test('ayarı project.json\'a yazar ve güncel doğrulamayı döner', async () => {
    await writeProject('write', { audio: tracksFor(242 * 60) });
    const res = await updatePomodoro('write', { enabled: true, rounds: 4, statuses: CLASSIC }, options());

    assert.equal(res.enabled, true);
    assert.equal(res.validation.ok, true);
    assert.deepEqual((await readProjectJson('write')).pomodoro, {
      enabled: true,
      rounds: 4,
      statuses: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }],
    });
  });

  test('kırpma onayı alanı artık yok: gönderilirse bilinmeyen alan olarak reddedilir', async () => {
    await writeProject('confirm', { audio: tracksFor(255 * 60) });
    await assert.rejects(
      updatePomodoro('confirm', { enabled: true, statuses: CLASSIC, rounds: 4, trimExcess: true }, options()),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('kapatmak anahtarı siler — kapalı Pomodoro dosyada artık bırakmaz', async () => {
    await writeProject('disable', {
      project: { pomodoro: { enabled: true, preset: '30/10', rounds: 6 } },
      audio: tracksFor(600),
    });
    const res = await updatePomodoro('disable', { enabled: false }, options());

    assert.equal(res.enabled, false);
    assert.equal(Object.hasOwn(await readProjectJson('disable'), 'pomodoro'), false);
  });

  test('geçersiz değer 422, dosya değişmez', async () => {
    await writeProject('invalid', { audio: tracksFor(600) });
    await assert.rejects(
      updatePomodoro('invalid', { enabled: true, rounds: 0 }, options()),
      (error) => error instanceof ApiError && error.status === 422,
    );
    assert.equal(Object.hasOwn(await readProjectJson('invalid'), 'pomodoro'), false);
  });

  test('enabled alanı zorunlu', async () => {
    await writeProject('noflag', { audio: tracksFor(600) });
    await assert.rejects(
      updatePomodoro('noflag', { rounds: 4 }, options()),
      (error) => error instanceof ApiError && error.status === 400,
    );
  });

  test('HTTP üzerinden de aynı yoldan geçer', async () => {
    await writeProject('http', { audio: tracksFor(242 * 60) });
    const put = await fetch(`${url}/api/projects/http/pomodoro`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, statuses: CLASSIC, rounds: 4 }),
    });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).validation.ok, true);

    const get = await fetch(`${url}/api/projects/http/pomodoro`);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).validation.timeline.totalMinutes, 232);
  });
});

describe('PUT /api/projects/:id/pomodoro — mola görüntüsü', () => {
  async function projectWithFiles(name) {
    const dir = await writeProject(name, { audio: tracksFor(242 * 60) });
    await mkdir(join(dir, 'videolar'), { recursive: true });
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await writeFile(join(dir, 'videolar', 'mola.mp4'), 'x');
    await writeFile(join(dir, 'resimler', 'mola.png'), 'x');
    return dir;
  }

  test('mola görüntüsünü ./göreli yol olarak yazar; ayar geri okununca aynı gelir', async () => {
    await projectWithFiles('break-write');
    const res = await updatePomodoro(
      'break-write', { enabled: true, rounds: 4, statuses: withBreak('resimler/mola.png') }, options(),
    );

    assert.equal(res.settings.statuses[1].visual, './resimler/mola.png');
    assert.equal((await readProjectJson('break-write')).pomodoro.statuses[1].visual, './resimler/mola.png');
    assert.equal(Object.hasOwn((await readProjectJson('break-write')).pomodoro, 'breakClip'), false);
  });

  test('görüntüsüz gönderilen durum ana görüntüyü kullanır (görüntü kaldırılır)', async () => {
    await projectWithFiles('break-clear');
    await updatePomodoro('break-clear', { enabled: true, rounds: 4, statuses: withBreak('videolar/mola.mp4') }, options());
    const res = await updatePomodoro('break-clear', { enabled: true, rounds: 4, statuses: withBreak() }, options());

    assert.equal(res.settings.statuses[1].visual, null);
    assert.equal(Object.hasOwn((await readProjectJson('break-clear')).pomodoro.statuses[1], 'visual'), false);
  });

  test('olmayan dosya, proje dışı yol ve yanlış tür 422 — dosya değişmez', async () => {
    await projectWithFiles('break-bad');
    for (const breakClip of ['videolar/yok.mp4', '../baska/mola.mp4', 'audio/' + tracksFor(60, 1)[0]]) {
      await assert.rejects(
        updatePomodoro('break-bad', { enabled: true, rounds: 4, statuses: withBreak(breakClip) }, options()),
        (error) => error instanceof ApiError && error.status === 422,
        breakClip,
      );
    }
    assert.equal(Object.hasOwn(await readProjectJson('break-bad'), 'pomodoro'), false);
  });

  test('proje durumu seçilebilecek dosyaları iki klasörden listeler', async () => {
    await projectWithFiles('break-list');
    await updatePomodoro('break-list', { enabled: true, rounds: 4, statuses: withBreak('videolar/mola.mp4') }, options());
    const project = await getProject('break-list', { videosDir });

    assert.deepEqual([...project.visualCandidates].sort(), ['resimler/mola.png', 'videolar/mola.mp4']);
    assert.deepEqual(project.pomodoroVisuals, {
      intro: { value: '', exists: false },
      statuses: [{ value: '', exists: false }, { value: './videolar/mola.mp4', exists: true }],
    });
    assert.deepEqual(project.readiness.pomodoro.statuses.map((s) => [s.name, s.visual]), [
      ['STUDY', null], ['BREAK', './videolar/mola.mp4'],
    ]);
    assert.equal(project.readiness.pomodoro.countdownBeep, true);
    assert.equal(project.readiness.pomodoro.intro.visual, null);
  });
});

describe('PUT /api/projects/:id/pomodoro — özel durumlar (statuses)', () => {
  async function projectWithFiles(name) {
    const dir = await writeProject(name, { audio: tracksFor(2 * 60 + 2 * 40 * 60) });
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await writeFile(join(dir, 'resimler', 'esneme.png'), 'x');
    await writeFile(join(dir, 'resimler', 'hazir.png'), 'x');
    return dir;
  }

  const stretchCycle = [
    { name: 'STUDY', minutes: 25 },
    { name: 'STRETCH', minutes: 5, visual: 'resimler/esneme.png', beep: false },
    { name: 'BREAK', minutes: 10 },
  ];

  test('durum listesini ve GET READY görüntüsünü yazar; ayar geri okununca aynı gelir', async () => {
    await projectWithFiles('st-write');
    const res = await updatePomodoro('st-write', {
      enabled: true, rounds: 2, statuses: stretchCycle, intro: { visual: 'resimler/hazir.png' },
    }, options());

    assert.equal(res.validation.timeline.totalMinutes, 2 + 2 * 40 - 15);
    assert.deepEqual(res.settings.statuses.map((s) => [s.name, s.minutes, s.beep]), [
      ['STUDY', 25, true], ['STRETCH', 5, false], ['BREAK', 10, true],
    ]);
    assert.equal(res.settings.statuses[1].visual, './resimler/esneme.png');
    assert.equal(res.settings.intro.visual, './resimler/hazir.png');

    assert.deepEqual((await readProjectJson('st-write')).pomodoro, {
      enabled: true,
      rounds: 2,
      statuses: [
        { name: 'STUDY', minutes: 25 },
        { name: 'STRETCH', minutes: 5, visual: './resimler/esneme.png', beep: false },
        { name: 'BREAK', minutes: 10 },
      ],
      intro: { visual: './resimler/hazir.png' },
    });
  });

  test('eski anahtarlar (preset, workMinutes, breakMinutes, breakClip) 400 ile reddedilir — dosya değişmez', async () => {
    await projectWithFiles('st-legacy-body');
    for (const extra of [{ preset: '50/10' }, { workMinutes: 30 }, { breakMinutes: 5 }, { breakClip: 'resimler/esneme.png' }]) {
      await assert.rejects(
        updatePomodoro('st-legacy-body', { enabled: true, rounds: 1, statuses: CLASSIC, ...extra }, options()),
        (error) => error instanceof ApiError && error.status === 400 && /statuses/.test(error.message),
        JSON.stringify(extra),
      );
    }
    assert.equal(Object.hasOwn(await readProjectJson('st-legacy-body'), 'pomodoro'), false);
  });

  test('eski project.json (breakClip) okunur; ayar yeniden yazılınca BREAK görüntüsü korunur', async () => {
    const dir = await projectWithFiles('st-legacy');
    await writeFile(join(dir, 'project.json'), JSON.stringify({
      clip: './videolar/in.mp4', audioDir: './audio', video: { cropBottom: 150 },
      pomodoro: { enabled: true, workMinutes: 50, breakMinutes: 10, rounds: 2, breakClip: './resimler/esneme.png' },
    }));
    const before = await getPomodoro('st-legacy', options());
    assert.deepEqual(before.settings.statuses.map((s) => s.name), ['STUDY', 'BREAK']);
    assert.equal(before.settings.statuses[1].visual, './resimler/esneme.png');

    await updatePomodoro('st-legacy', { enabled: true, rounds: 3, statuses: before.settings.statuses }, options());
    const written = (await readProjectJson('st-legacy')).pomodoro;
    assert.equal(written.rounds, 3);
    assert.equal(written.statuses[1].visual, './resimler/esneme.png');
    assert.equal('breakClip' in written, false);
  });

  test('geçersiz durumlar 422 ve anlaşılır mesaj — dosya değişmez', async () => {
    await projectWithFiles('st-bad');
    const cases = [
      [{ statuses: [] }, /pomodoro\.statuses/],
      [{ statuses: [{ name: 'A'.repeat(30), minutes: 5 }] }, /statuses\[0\]\.name/],
      [{ statuses: [{ name: 'A', minutes: 500 }] }, /statuses\[0\]\.minutes/],
      [{ statuses: [{ name: 'A', minutes: 5, visual: 'resimler/yok.png' }] }, /bulunamadı/],
      [{ statuses: [{ name: 'A', minutes: 5 }], intro: { visual: '../disari.png' } }, /proje klasörünün içinde/],
    ];
    for (const [extra, pattern] of cases) {
      await assert.rejects(
        updatePomodoro('st-bad', { enabled: true, rounds: 2, ...extra }, options()),
        (error) => error instanceof ApiError && error.status === 422 && pattern.test(error.message),
        JSON.stringify(extra),
      );
    }
    assert.equal(Object.hasOwn(await readProjectJson('st-bad'), 'pomodoro'), false);
  });

  test('çoklu set: sets yazılır, adım görüntüsü göreli yol olur, readiness setleri taşır', async () => {
    await projectWithFiles('sets-write');
    const sets = [
      { name: 'SET 1', steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }] },
      { repeat: 2, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'UZUN', minutes: 15, kind: 'break', visual: 'resimler/esneme.png' }] },
    ];
    const res = await updatePomodoro('sets-write', { enabled: true, rounds: 1, sets }, options());

    assert.equal(res.validation.timeline.totalMinutes, 2 + 30 + 2 * 40 - 15);
    assert.deepEqual(res.settings.sets.map((set) => [set.name, set.repeat, set.steps.length]), [['SET 1', 1, 2], ['SET 2', 2, 2]]);
    assert.equal(res.settings.statuses.length, 6);
    assert.equal(res.settings.sets[1].steps[1].visual, './resimler/esneme.png');
    assert.deepEqual(res.defaults.sets[0].steps.map((s) => s.name), ['STUDY', 'BREAK']);

    const written = (await readProjectJson('sets-write')).pomodoro;
    assert.equal(written.statuses, undefined);
    assert.deepEqual(written.sets, [
      { steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }] },
      { repeat: 2, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'UZUN', minutes: 15, kind: 'break', visual: './resimler/esneme.png' }] },
    ]);

    const project = await getProject('sets-write', options());
    assert.deepEqual(project.readiness.pomodoro.sets.map((set) => set.repeat), [1, 2]);
    assert.equal(project.readiness.pomodoro.statuses.length, 6);

    // Tek sete dönünce `sets` kalmaz, kısayol yazılır (ayar her seferinde tümüyle yazılır).
    await updatePomodoro('sets-write', { enabled: true, rounds: 1, statuses: CLASSIC }, options());
    const back = (await readProjectJson('sets-write')).pomodoro;
    assert.equal(back.sets, undefined);
    assert.deepEqual(back.statuses, CLASSIC);
  });

  test('geçersiz setler 422 ve dosya değişmez; yanlış türde sets 400', async () => {
    await projectWithFiles('sets-bad');
    const cases = [
      [[{ repeat: 0, steps: CLASSIC }], /sets\[0\]\.repeat/],
      [[{ steps: [{ name: 'A', minutes: 5, kind: 'uyku' }] }], /sets\[0\]\.steps\[0\]\.kind/],
      [[{ steps: [{ name: 'A', minutes: 5, visual: 'resimler/yok.png' }] }], /bulunamadı/],
    ];
    for (const [sets, pattern] of cases) {
      await assert.rejects(
        updatePomodoro('sets-bad', { enabled: true, rounds: 1, sets }, options()),
        (error) => error instanceof ApiError && error.status === 422 && pattern.test(error.message),
        JSON.stringify(sets),
      );
    }
    await assert.rejects(
      updatePomodoro('sets-bad', { enabled: true, sets: 'x' }, options()),
      (error) => error instanceof ApiError && error.status === 400,
    );
    assert.equal(Object.hasOwn(await readProjectJson('sets-bad'), 'pomodoro'), false);
  });

  test('yanlış türde alan 400', async () => {
    await projectWithFiles('st-type');
    for (const body of [{ statuses: 'x' }, { intro: 'x' }]) {
      await assert.rejects(
        updatePomodoro('st-type', { enabled: true, ...body }, options()),
        (error) => error instanceof ApiError && error.status === 400,
      );
    }
  });
});

describe('Pomodoro: ana görüntü durum görüntülerinden türer', () => {
  async function projectNoClip(name, extra = {}) {
    const dir = await writeProject(name, { project: { clip: '', ...extra }, audio: tracksFor(600) });
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await mkdir(join(dir, 'videolar'), { recursive: true });
    for (const file of ['resimler/calisma.png', 'resimler/mola.png', 'resimler/hazir.png', 'videolar/calisma.mp4', 'videolar/elle.mp4']) {
      await writeFile(join(dir, file), 'x');
    }
    return dir;
  }
  const put = (id, statuses, extra = {}) => updatePomodoro(id, { enabled: true, rounds: 1, statuses, ...extra }, options());

  test('ana görüntü boşsa ilk çalışma adımının görüntüsü olur; tür uzantıdan', async () => {
    await projectNoClip('main-auto');
    await put('main-auto', [
      { name: 'BREAK', minutes: 5, visual: 'resimler/mola.png' },
      { name: 'STUDY', minutes: 25, visual: 'resimler/calisma.png' },
    ]);
    let json = await readProjectJson('main-auto');
    assert.equal(json.clip, './resimler/calisma.png');
    assert.equal(json.video.source, 'image');
    assert.equal(json.video.clipFromPomodoro, true);
    assert.equal(json.video.cropBottom, 150, 'kırpma korunur');

    // STUDY görüntüsü videoya dönünce ana görüntü de değişir (otomatik yazıldığı için).
    await put('main-auto', [
      { name: 'BREAK', minutes: 5, visual: 'resimler/mola.png' },
      { name: 'STUDY', minutes: 25, visual: 'videolar/calisma.mp4' },
    ]);
    json = await readProjectJson('main-auto');
    assert.equal(json.clip, './videolar/calisma.mp4');
    assert.equal(json.video.source, 'clip');
  });

  test('öncelik: çalışmanın görüntüsü yoksa ilk görüntülü adım, o da yoksa GET READY; hiç yoksa boş', async () => {
    await projectNoClip('main-order');
    await put('main-order', [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5, visual: 'resimler/mola.png' }]);
    assert.equal((await readProjectJson('main-order')).clip, './resimler/mola.png');

    await put('main-order', [{ name: 'STUDY', minutes: 25 }], { intro: { visual: 'resimler/hazir.png' } });
    assert.equal((await readProjectJson('main-order')).clip, './resimler/hazir.png');

    await put('main-order', [{ name: 'STUDY', minutes: 25 }]);
    assert.equal((await readProjectJson('main-order')).clip, '');
  });

  test('elle seçilmiş ana görüntü korunur', async () => {
    await projectNoClip('main-manual', { clip: './videolar/elle.mp4' });
    await put('main-manual', [{ name: 'STUDY', minutes: 25, visual: 'resimler/calisma.png' }]);
    const json = await readProjectJson('main-manual');
    assert.equal(json.clip, './videolar/elle.mp4');
    assert.equal(json.video.clipFromPomodoro, undefined);
  });

  test('başka bir dosya elle seçilince otomatik işaret kalkar; aynı dosya yeniden kaydedilince kalır', async () => {
    const dir = await projectNoClip('main-switch');
    await put('main-switch', [{ name: 'STUDY', minutes: 25, visual: 'videolar/calisma.mp4' }]);
    const projectPath = join(dir, 'project.json');
    await setProjectClip(projectPath, './videolar/calisma.mp4');
    assert.equal((await readProjectJson('main-switch')).video.clipFromPomodoro, true);
    await setProjectClip(projectPath, './videolar/elle.mp4');
    const json = await readProjectJson('main-switch');
    assert.equal(json.clip, './videolar/elle.mp4');
    assert.equal(json.video.clipFromPomodoro, undefined);
  });
});

describe('görsel kartları: küçük resimler ve etiket önizlemesi', () => {
  async function projectWithVisuals(name) {
    const dir = await writeProject(name, { audio: tracksFor(242 * 60) });
    await mkdir(join(dir, 'videolar'), { recursive: true });
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await writeFile(join(dir, 'videolar', 'calisma.mp4'), 'v');
    await writeFile(join(dir, 'resimler', 'mola.png'), 'p');
    return dir;
  }

  test('assets/visual iki klasördeki her dosyayı doğru türle sunar, olmayanı 404', async () => {
    await projectWithVisuals('visuals');
    const png = await getAsset('visuals', 'visual', 'mola.png', { videosDir });
    const mp4 = await getAsset('visuals', 'visual', 'calisma.mp4', { videosDir });
    assert.equal(png.contentType, 'image/png');
    assert.equal(mp4.contentType, 'video/mp4');
    await assert.rejects(
      getAsset('visuals', 'visual', 'yok.png', { videosDir }),
      (error) => error instanceof ApiError && error.status === 404,
    );
    // Müzik dosyası görsel olarak sunulmaz.
    await assert.rejects(
      getAsset('visuals', 'visual', 'x-t-60.m4a', { videosDir }),
      (error) => error instanceof ApiError && error.status === 404,
    );
  });

  test('etiket önizlemesi: görüntüsü seçili durumlar kendi önizlemesini, öbürleri null verir', async () => {
    await projectWithVisuals('labels-break');
    const without = await getLabels('labels-break', { videosDir });
    assert.deepEqual(without.statusPreviews, []);
    assert.equal(without.introPreview, null);

    await updatePomodoro('labels-break', { enabled: true, rounds: 2, statuses: withBreak('resimler/mola.png') }, options());
    const labelsWithBreak = await getLabels('labels-break', { videosDir });
    assert.equal(labelsWithBreak.introPreview, null);
    assert.deepEqual(labelsWithBreak.statusPreviews, [null, {
      url: '/api/projects/labels-break/assets/visual/mola.png',
      kind: 'image',
    }]);
  });

  test('GET READY ve özel durum görüntüleri de önizlemeye gelir; video ise türü video', async () => {
    await projectWithVisuals('labels-break-video');
    await updatePomodoro('labels-break-video', {
      enabled: true,
      rounds: 2,
      statuses: [
        { name: 'STUDY', minutes: 25 },
        { name: 'STRETCH', minutes: 5, visual: 'videolar/calisma.mp4' },
      ],
      intro: { visual: 'resimler/mola.png' },
    }, options());
    const labels = await getLabels('labels-break-video', { videosDir });
    assert.equal(labels.statusPreviews[0], null);
    assert.equal(labels.statusPreviews[1].kind, 'video');
    assert.equal(labels.introPreview.kind, 'image');
  });
});

describe('montaj başlatma engeli', () => {
  /** startBuild'in buraya kadar gelmesi için gereken en küçük proje. */
  async function buildableProject(name, { pomodoro, totalSeconds, audio = tracksFor(totalSeconds) }) {
    const dir = await writeProject(name, {
      project: { clip: './videolar/in.mp4', pomodoro },
      audio,
    });
    await mkdir(join(dir, 'videolar'), { recursive: true });
    await writeFile(join(dir, 'videolar', 'in.mp4'), 'fake');
    await mkdir(join(dir, 'resimler'), { recursive: true });
    await writeFile(join(dir, 'resimler', 'MASTER.png'), 'fake');
    return dir;
  }

  const buildJobs = {
    started: [],
    start(id, input) { this.started.push(id); return { projectId: id, state: 'running', ...input }; },
  };

  test('doğrulama geçmezse (ölçülemeyen parça) montaj HİÇ başlamaz (409)', async () => {
    await buildableProject('no-build', {
      pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
      // Adında süre yok: sahte ffprobe ölçemez.
      audio: ['bozuk.m4a'],
    });

    await assert.rejects(
      startBuild('no-build', {}, { videosDir, buildJobs, probeFn: fakeProbe }),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        assert.ok(error.message.includes('Pomodoro') || error.details?.pomodoro?.problems?.some((p) => p.includes('ölçülemedi')));
        return true;
      },
    );
    assert.deepEqual(buildJobs.started, []);
  });

  test('doğrulama geçerse montaj başlar', async () => {
    await buildableProject('go-build', {
      pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
      totalSeconds: 242 * 60,
    });

    const job = await startBuild('go-build', {}, { videosDir, buildJobs, probeFn: fakeProbe });
    assert.equal(job.state, 'running');
    assert.deepEqual(buildJobs.started, ['go-build']);
  });

  test('eksik müzik montajı ENGELLEMEZ (kalan süreyi Ambiance doldurur)', async () => {
    await buildableProject('short-build', {
      pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
      totalSeconds: 229.5 * 60,
    });
    const before = buildJobs.started.length;

    const job = await startBuild('short-build', {}, { videosDir, buildJobs, probeFn: fakeProbe });
    assert.equal(job.state, 'running');
    assert.equal(buildJobs.started.length, before + 1);
  });

  test('fazla müzik montajı ENGELLEMEZ (otomatik kırpılır)', async () => {
    await buildableProject('excess-build', {
      pomodoro: { enabled: true, preset: '50/10', rounds: 4 },
      totalSeconds: 255 * 60,
    });
    const before = buildJobs.started.length;

    const job = await startBuild('excess-build', {}, { videosDir, buildJobs, probeFn: fakeProbe });
    assert.equal(job.state, 'running');
    assert.equal(buildJobs.started.length, before + 1);
  });

  test('Test 6 — Pomodoro kapalı projede montaj hiçbir ek şart görmeden başlar', async () => {
    await buildableProject('plain', { pomodoro: undefined, totalSeconds: 123 });
    const job = await startBuild('plain', {}, { videosDir, buildJobs, probeFn: fakeProbe });
    assert.equal(job.state, 'running');
  });
});
