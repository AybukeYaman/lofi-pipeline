/**
 * prep/pomodoro-sets.js + server/pomodoro-set-api.js — kayıtlı programlar (setler + adımlar).
 *
 * Depo geçici klasörde: gerçek pomodoro-sets/ klasörüne dokunulmaz.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  BUILTIN_SET_IDS, PomodoroSetError,
  deletePomodoroSet, listPomodoroSetIds, listPomodoroSets, loadPomodoroSet, writePomodoroSet,
} from '../../prep/pomodoro-sets.js';
import {
  createPomodoroSet, getPomodoroSet, getPomodoroSets, removePomodoroSet, updatePomodoroSet,
} from '../../server/pomodoro-set-api.js';
import { createWebServer } from '../../server/web-server.js';
import { tempDir } from '../helpers/fixtures.js';

let root;
let n = 0;

/** Boş bir set klasörü. */
const library = async () => {
  const dir = root.path(`sets${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

const CYCLE = [
  { name: 'STUDY', minutes: 25 },
  { name: 'STRETCH', minutes: 5, beep: false },
  { name: 'BREAK', minutes: 10 },
];

before(async () => { root = await tempDir('pomodoro-sets'); });
after(() => root?.cleanup());

describe('set deposu — yaz, oku, sil', () => {
  test('yazılan set geri okunur; bip açıksa dosyaya yazılmaz, updatedAt eklenir', async () => {
    const dir = await library();
    const now = () => new Date('2026-10-13T10:00:00Z');
    const written = await writePomodoroSet({ id: 'odak-25', name: '  Odak 25  ', statuses: CYCLE }, { dir, now });

    assert.equal(written.name, 'Odak 25');
    assert.equal(written.updatedAt, '2026-10-13T10:00:00.000Z');
    const onDisk = JSON.parse(await readFile(join(dir, 'odak-25.json'), 'utf8'));
    assert.deepEqual(onDisk.statuses, [
      { name: 'STUDY', minutes: 25 },
      { name: 'STRETCH', minutes: 5, beep: false },
      { name: 'BREAK', minutes: 10 },
    ]);

    const loaded = await loadPomodoroSet('odak-25', { dir });
    assert.deepEqual(loaded.statuses.map((s) => [s.name, s.minutes, s.beep]), [
      ['STUDY', 25, true], ['STRETCH', 5, false], ['BREAK', 10, true],
    ]);
  });

  test('görüntü sete girmez: yazarken de, dosyada olsa da okurken de atılır', async () => {
    const dir = await library();
    await writePomodoroSet({
      id: 'gorselli',
      name: 'Görselli',
      statuses: [{ name: 'STUDY', minutes: 50, visual: './resimler/x.png' }],
    }, { dir });
    const onDisk = JSON.parse(await readFile(join(dir, 'gorselli.json'), 'utf8'));
    assert.equal('visual' in onDisk.statuses[0], false);

    await writeFile(join(dir, 'elle.json'), JSON.stringify({
      name: 'Elle', statuses: [{ name: 'A', minutes: 5, visual: 42 }],
    }));
    const loaded = await loadPomodoroSet('elle', { dir });
    assert.equal('visual' in loaded.statuses[0], false);
    assert.equal('visual' in loaded.sets[0].steps[0], false);
  });

  test('çoklu set programı sets olarak yazılır, tekrar ve tür korunur', async () => {
    const dir = await library();
    await writePomodoroSet({
      id: 'uzun-mola',
      name: 'Uzun mola',
      sets: [
        { name: 'SET 1', repeat: 3, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }] },
        { name: 'Son', steps: [{ name: 'STUDY', minutes: 25 }, { name: 'UZUN', minutes: 15, kind: 'break', visual: './x.png' }] },
      ],
    }, { dir });
    const onDisk = JSON.parse(await readFile(join(dir, 'uzun-mola.json'), 'utf8'));
    assert.equal(onDisk.statuses, undefined);
    assert.deepEqual(onDisk.sets, [
      { repeat: 3, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }] },
      { name: 'Son', steps: [{ name: 'STUDY', minutes: 25 }, { name: 'UZUN', minutes: 15, kind: 'break' }] },
    ]);

    const loaded = await loadPomodoroSet('uzun-mola', { dir });
    assert.deepEqual(loaded.sets.map((set) => [set.name, set.repeat, set.steps.length]), [['SET 1', 3, 2], ['Son', 1, 2]]);
    assert.equal(loaded.statuses.length, 8);
    assert.equal(loaded.sets[1].steps[1].kind, 'break');
  });

  test('geçersiz içerik diske hiç gitmez ve bütün sorunlar birlikte bildirilir', async () => {
    const dir = await library();
    await assert.rejects(
      writePomodoroSet({ id: 'kotu', name: '', statuses: [{ name: '', minutes: 0 }] }, { dir }),
      (error) => error instanceof PomodoroSetError
        && error.problems.some((p) => p.includes('name boş'))
        && error.problems.some((p) => p.includes('steps[0].name'))
        && error.problems.some((p) => p.includes('steps[0].minutes')),
    );
    assert.deepEqual(await listPomodoroSetIds({ dir }), []);
  });

  test('hazır düzen adıyla kayıt yapılamaz', async () => {
    const dir = await library();
    assert.deepEqual(BUILTIN_SET_IDS, ['50-10', '30-10', '50-10-50-20', 'klasik-25-5']);
    await assert.rejects(
      writePomodoroSet({ id: '50-10', name: '50/10', statuses: CYCLE }, { dir }),
      (error) => error instanceof PomodoroSetError && error.problems[0].includes('hazır bir düzene ait'),
    );
  });

  test('klasör yoksa liste boş (hata değil); bozuk dosya listeyi düşürmez', async () => {
    assert.deepEqual(await listPomodoroSetIds({ dir: root.path('yok') }), []);

    const dir = await library();
    await writePomodoroSet({ id: 'iyi', name: 'İyi', statuses: CYCLE }, { dir });
    await writeFile(join(dir, 'bozuk.json'), '{ nope');
    await writeFile(join(dir, 'Buyuk-Harf.json'), '{}');
    const sets = await listPomodoroSets({ dir });
    assert.deepEqual(sets.map((s) => s.id), ['bozuk', 'iyi']);
    assert.match(sets[0].error, /JSON ayrıştırılamadı/);
    assert.equal(sets[1].error, undefined);
  });

  test('silinen set listeden kalkar; olmayan kimlik hata verir', async () => {
    const dir = await library();
    await writePomodoroSet({ id: 'gecici', name: 'Geçici', statuses: CYCLE }, { dir });
    assert.equal(await deletePomodoroSet('gecici', { dir }), 'gecici');
    assert.deepEqual(await listPomodoroSetIds({ dir }), []);
    await assert.rejects(deletePomodoroSet('gecici', { dir }), /set bulunamadı/);
    await assert.rejects(loadPomodoroSet('Kotu_Ad', { dir }), /kebab-case/);
  });
});

describe('set API — liste, ekle, güncelle, sil', () => {
  test('liste hazır programları önde, kayıtlıları arkada verir', async () => {
    const dir = await library();
    await createPomodoroSet({ name: 'Odak 25', statuses: CYCLE }, { dir });
    const { sets, limits } = await getPomodoroSets({ dir });

    assert.deepEqual(sets.map((s) => [s.id, s.builtin]), [
      ['50-10', true], ['30-10', true], ['50-10-50-20', true], ['klasik-25-5', true], ['odak-25', false],
    ]);
    assert.deepEqual(sets[0].sets.map((set) => set.steps.map((step) => [step.name, step.minutes, step.kind])), [
      [['STUDY', 50, 'work'], ['BREAK', 10, 'break']],
    ]);
    assert.deepEqual(sets[3].sets.map((set) => set.repeat), [3, 1]);
    assert.equal('statuses' in sets[0], false);
    assert.equal('visual' in sets[0].sets[0].steps[0], false);
    assert.equal(limits.name, 60);
    assert.equal('path' in sets[4], false);
    assert.equal(sets[4].sets[0].steps.length, 3);
  });

  test('ekleme: kimlik addan türer; aynı ad 409, hazır düzen adı 409, harfsiz ad 400', async () => {
    const dir = await library();
    const created = await createPomodoroSet({ name: 'Uzun Mola Düzeni', statuses: CYCLE }, { dir });
    assert.equal(created.set.id, 'uzun-mola-duzeni');

    await assert.rejects(
      createPomodoroSet({ name: 'uzun mola düzeni', statuses: CYCLE }, { dir }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      createPomodoroSet({ name: '50-10', statuses: CYCLE }, { dir }),
      (error) => error.status === 409 && /built-in/.test(error.message),
    );
    await assert.rejects(
      createPomodoroSet({ name: '!!!', statuses: CYCLE }, { dir }),
      (error) => error.status === 400,
    );
    await assert.rejects(createPomodoroSet({ name: 'Eksik' }, { dir }), (error) => error.status === 400);
    await assert.rejects(
      createPomodoroSet({ name: 'Yanlış', statuses: 'x' }, { dir }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      createPomodoroSet({ name: 'Bos Liste', statuses: [] }, { dir }),
      (error) => error.status === 422 && error.details.problems.some((p) => p.includes('steps')),
    );
    await assert.rejects(
      createPomodoroSet({ name: 'Cok Tekrar', sets: [{ repeat: 11, steps: CYCLE }] }, { dir }),
      (error) => error.status === 422 && error.details.problems.some((p) => p.includes('repeat')),
    );
  });

  test('güncelleme: verilmeyen alan korunur, ad değişse de kimlik sabit kalır', async () => {
    const dir = await library();
    await createPomodoroSet({ name: 'Odak', statuses: CYCLE }, { dir });

    const renamed = await updatePomodoroSet('odak', { name: 'Odak Yeni' }, { dir });
    assert.equal(renamed.set.id, 'odak');
    assert.equal(renamed.set.name, 'Odak Yeni');
    assert.equal(renamed.set.sets[0].steps.length, 3);

    const shorter = await updatePomodoroSet('odak', { statuses: [{ name: 'STUDY', minutes: 90 }] }, { dir });
    assert.equal(shorter.set.name, 'Odak Yeni');
    assert.deepEqual(shorter.set.sets[0].steps.map((s) => s.minutes), [90]);

    const twoSets = await updatePomodoroSet('odak', {
      sets: [{ steps: [{ name: 'STUDY', minutes: 50 }] }, { repeat: 2, steps: [{ name: 'BREAK', minutes: 10 }] }],
    }, { dir });
    assert.deepEqual(twoSets.set.sets.map((set) => [set.name, set.repeat]), [['SET 1', 1], ['SET 2', 2]]);
    const renamedAgain = await updatePomodoroSet('odak', { name: 'Odak 3' }, { dir });
    assert.equal(renamedAgain.set.sets.length, 2);

    await assert.rejects(updatePomodoroSet('yok', { name: 'X' }, { dir }), (error) => error.status === 404);
    await assert.rejects(
      updatePomodoroSet('odak', { statuses: [{ name: 'A', minutes: 0 }] }, { dir }),
      (error) => error.status === 422,
    );
    await assert.rejects(updatePomodoroSet('odak', { bilinmeyen: 1 }, { dir }), (error) => error.status === 400);
  });

  test('hazır düzenler değiştirilemez ve silinemez; tek tek okunabilir', async () => {
    const dir = await library();
    await assert.rejects(updatePomodoroSet('50-10', { name: 'X' }, { dir }), (error) => error.status === 409);
    await assert.rejects(removePomodoroSet('30-10', { dir }), (error) => error.status === 409);
    assert.equal((await getPomodoroSet('30-10', { dir })).builtin, true);
  });

  test('silme: kayıtlı set gider, olmayan 404, geçersiz kimlik 400', async () => {
    const dir = await library();
    await createPomodoroSet({ name: 'Silinecek', statuses: CYCLE }, { dir });
    assert.deepEqual(await removePomodoroSet('silinecek', { dir }), { ok: true, deleted: 'silinecek' });
    await assert.rejects(removePomodoroSet('silinecek', { dir }), (error) => error.status === 404);
    await assert.rejects(getPomodoroSet('Kotu_Ad', { dir }), (error) => error.status === 400);
    await assert.rejects(getPomodoroSet('yok', { dir }), (error) => error.status === 404);
  });
});

describe('set rotaları (HTTP)', () => {
  let server;
  let url;
  let dir;

  before(async () => {
    dir = await library();
    server = createWebServer({
      projectApi: {
        getPomodoroSets: () => getPomodoroSets({ dir }),
        getPomodoroSet: (id) => getPomodoroSet(id, { dir }),
        createPomodoroSet: (body) => createPomodoroSet(body, { dir }),
        updatePomodoroSet: (id, body) => updatePomodoroSet(id, body, { dir }),
        removePomodoroSet: (id) => removePomodoroSet(id, { dir }),
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server?.close());

  const call = async (method, path, body) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  test('ekle → listele → güncelle → sil', async () => {
    const created = await call('POST', '/api/pomodoro-sets', { name: 'Rota Seti', statuses: CYCLE });
    assert.equal(created.status, 201);
    assert.equal(created.json.set.id, 'rota-seti');

    const listed = await call('GET', '/api/pomodoro-sets');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.sets.map((s) => s.id), ['50-10', '30-10', '50-10-50-20', 'klasik-25-5', 'rota-seti']);

    const updated = await call('PUT', '/api/pomodoro-sets/rota-seti', { name: 'Rota Seti 2' });
    assert.equal(updated.json.set.name, 'Rota Seti 2');
    assert.equal((await call('GET', '/api/pomodoro-sets/rota-seti')).json.name, 'Rota Seti 2');

    assert.equal((await call('POST', '/api/pomodoro-sets', { name: 'Rota Seti', statuses: CYCLE })).status, 409);
    assert.equal((await call('DELETE', '/api/pomodoro-sets/50-10')).status, 409);
    assert.equal((await call('DELETE', '/api/pomodoro-sets/rota-seti')).status, 200);
    assert.equal((await call('GET', '/api/pomodoro-sets/rota-seti')).status, 404);
  });
});
