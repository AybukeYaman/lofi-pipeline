/**
 * prep/prompt-library.js + server/prompt-api.js — kullanıcının prompt deposu.
 *
 * Depo geçici klasörde: gerçek prompts/library/ klasörüne dokunulmaz.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  PROMPT_LIMITS, PromptLibraryError,
  deletePrompt, listPromptIds, listPrompts, loadPrompt, promptIdFrom, writePrompt,
} from '../../prep/prompt-library.js';
import {
  createPrompt, getPrompt, getPrompts, removePrompt, updatePrompt,
} from '../../server/prompt-api.js';
import { tempDir } from '../helpers/fixtures.js';

let root;
let n = 0;

/** Boş bir kütüphane klasörü. */
const library = async () => {
  const dir = root.path(`lib${n++}`);
  await mkdir(dir, { recursive: true });
  return dir;
};

before(async () => { root = await tempDir('prompt-library'); });
after(() => root?.cleanup());

describe('promptIdFrom — başlıktan dosya adı', () => {
  test('Türkçe harfler ASCII olur, noktalama tireye döner', () => {
    assert.equal(promptIdFrom('Müzik ambiyans tanımı'), 'muzik-ambiyans-tanimi');
    assert.equal(promptIdFrom('Görsel Üretimi: ÇOK ÖZEL!'), 'gorsel-uretimi-cok-ozel');
    assert.equal(promptIdFrom('  boşluk   ve---tire  '), 'bosluk-ve-tire');
    assert.equal(promptIdFrom('Işık'), 'isik');
  });

  test('harf/rakam içermeyen başlık boş kimlik verir (çağıran reddeder)', () => {
    for (const title of ['', '   ', '!!!', '---']) assert.equal(promptIdFrom(title), '');
  });

  test('kimlik 60 karakterle sınırlı ve sonunda tire bırakmaz', () => {
    const id = promptIdFrom('a'.repeat(58) + ' bbbb');
    assert.ok(id.length <= 60, id.length);
    assert.doesNotMatch(id, /-$/);
  });
});

describe('prompt deposu — yaz, oku, sil', () => {
  test('yazılan prompt geri okunur; metin normalize edilir, updatedAt yazılır', async () => {
    const dir = await library();
    const written = await writePrompt({
      id: 'muzik-ambiyans',
      title: '  Müzik ambiyans tanımı  ',
      text: 'İlk satır\r\nikinci satır\r\n',
      note: ' 50 parçalık albüm için ',
      tags: ['music'],
    }, { dir, now: () => new Date('2026-09-27T10:00:00Z') });

    assert.equal(written.title, 'Müzik ambiyans tanımı', 'başlık kırpılmalı');
    assert.equal(written.text, 'İlk satır\nikinci satır', 'CRLF ve sondaki boşluk temizlenmeli');
    assert.equal(written.note, '50 parçalık albüm için');
    assert.deepEqual(written.tags, ['music']);
    assert.equal(written.updatedAt, '2026-09-27T10:00:00.000Z');

    const read = await loadPrompt('muzik-ambiyans', { dir });
    assert.equal(read.text, written.text);
    assert.deepEqual(await listPromptIds({ dir }), ['muzik-ambiyans']);

    // Diskteki biçim: okunabilir JSON, LF, sonda tek satır sonu.
    const raw = await readFile(join(dir, 'muzik-ambiyans.json'), 'utf8');
    assert.ok(raw.endsWith('}\n') && !raw.includes('\r'));
  });

  test('kütüphane klasörü yoksa liste boş; ilk yazımda klasör kurulur', async () => {
    const dir = join(root.path(`yeni${n++}`), 'library');
    assert.deepEqual(await listPromptIds({ dir }), []);
    await writePrompt({ id: 'ilk', title: 'İlk', text: 'metin' }, { dir });
    assert.deepEqual(await listPromptIds({ dir }), ['ilk']);
  });

  test('etiket verilmezse general; yinelenen etiket tekilleşir', async () => {
    const dir = await library();
    const a = await writePrompt({ id: 'a', title: 'A', text: 'x' }, { dir });
    assert.deepEqual(a.tags, ['general']);
    const b = await writePrompt({ id: 'b', title: 'B', text: 'x', tags: ['music', 'music', 'image'] }, { dir });
    assert.deepEqual(b.tags, ['music', 'image']);
  });

  test('geçersiz içerik diske hiç yazılmaz; sorunlar tek seferde bildirilir', async () => {
    const dir = await library();
    await assert.rejects(
      writePrompt({ id: 'Bozuk Id', title: '', text: '' }, { dir }),
      (error) => {
        assert.ok(error instanceof PromptLibraryError);
        assert.equal(error.problems.length, 3, error.problems.join(' | '));
        assert.ok(error.problems.some((p) => p.includes('kebab-case')));
        assert.ok(error.problems.some((p) => p.includes('title boş')));
        assert.ok(error.problems.some((p) => p.includes('text boş')));
        return true;
      },
    );
    assert.deepEqual(await listPromptIds({ dir }), [], 'hiçbir dosya oluşmamalı');

    await assert.rejects(
      writePrompt({ id: 'uzun', title: 'A', text: 'x'.repeat(PROMPT_LIMITS.text + 1) }, { dir }),
      /text en fazla/,
    );
    await assert.rejects(
      writePrompt({ id: 'etiket', title: 'A', text: 'x', tags: ['ses'] }, { dir }),
      /bilinmeyen etiket: "ses"/,
    );
  });

  test('bozuk dosya kütüphaneyi düşürmez, error alanıyla listelenir', async () => {
    const dir = await library();
    await writePrompt({ id: 'saglam', title: 'Sağlam', text: 'metin' }, { dir });
    await writeFile(join(dir, 'bozuk.json'), '{ bu json değil');

    const prompts = await listPrompts({ dir });
    assert.deepEqual(prompts.map((p) => p.id), ['bozuk', 'saglam']);
    assert.match(prompts.find((p) => p.id === 'bozuk').error, /JSON ayrıştırılamadı/);
    assert.equal(prompts.find((p) => p.id === 'saglam').error, undefined);
  });

  test('olmayan prompt okunamaz ve silinemez', async () => {
    const dir = await library();
    await assert.rejects(loadPrompt('yok', { dir }), /prompt bulunamadı/);
    await assert.rejects(deletePrompt('yok', { dir }), /prompt bulunamadı/);
    await assert.rejects(loadPrompt('Büyük Harf', { dir }), /kebab-case/);
  });

  test('silinen prompt listeden çıkar', async () => {
    const dir = await library();
    await writePrompt({ id: 'gidecek', title: 'Gidecek', text: 'x' }, { dir });
    assert.equal(await deletePrompt('gidecek', { dir }), 'gidecek');
    assert.deepEqual(await listPromptIds({ dir }), []);
  });
});

describe('prompt API — durum kodları', () => {
  const statusOf = async (fn) => {
    try {
      await fn();
      return 200;
    } catch (error) {
      return error.status ?? 500;
    }
  };

  test('ekle → listele → güncelle → sil', async () => {
    const dir = await library();
    const { prompt } = await createPrompt(
      { title: 'Müzik ambiyans tanımı', text: 'Tamam, bu ambiyansla ilgili...', tags: ['music'] },
      { dir },
    );
    assert.equal(prompt.id, 'muzik-ambiyans-tanimi');

    const list = await getPrompts({ dir });
    assert.equal(list.prompts.length, 1);
    assert.deepEqual(list.tags, ['general', 'image', 'music', 'video']);
    assert.equal(list.limits.text, PROMPT_LIMITS.text);

    // Verilmeyen alan korunur, başlık değişse de kimlik sabit kalır.
    const updated = await updatePrompt('muzik-ambiyans-tanimi', { title: 'Yeni başlık' }, { dir });
    assert.equal(updated.prompt.id, 'muzik-ambiyans-tanimi');
    assert.equal(updated.prompt.title, 'Yeni başlık');
    assert.equal(updated.prompt.text, 'Tamam, bu ambiyansla ilgili...');
    assert.deepEqual(updated.prompt.tags, ['music']);

    // note: null notu siler.
    await updatePrompt('muzik-ambiyans-tanimi', { note: 'bir not' }, { dir });
    assert.equal((await getPrompt('muzik-ambiyans-tanimi', { dir })).note, 'bir not');
    await updatePrompt('muzik-ambiyans-tanimi', { note: null }, { dir });
    assert.equal((await getPrompt('muzik-ambiyans-tanimi', { dir })).note, null);

    assert.deepEqual(await removePrompt('muzik-ambiyans-tanimi', { dir }), {
      ok: true, deleted: 'muzik-ambiyans-tanimi',
    });
    assert.deepEqual((await getPrompts({ dir })).prompts, []);
  });

  test('aynı başlık 409, eksik alan 400, harfsiz başlık 400, olmayan prompt 404', async () => {
    const dir = await library();
    await createPrompt({ title: 'Aynı', text: 'x' }, { dir });

    assert.equal(await statusOf(() => createPrompt({ title: 'Aynı', text: 'y' }, { dir })), 409);
    assert.equal(await statusOf(() => createPrompt({ title: 'Eksik' }, { dir })), 400);
    assert.equal(await statusOf(() => createPrompt({ title: '!!!', text: 'x' }, { dir })), 400);
    assert.equal(await statusOf(() => createPrompt({ title: 'X', text: 'x', kim: 1 }, { dir })), 400);
    assert.equal(await statusOf(() => getPrompt('yok', { dir })), 404);
    assert.equal(await statusOf(() => updatePrompt('yok', { text: 'x' }, { dir })), 404);
    assert.equal(await statusOf(() => removePrompt('yok', { dir })), 404);
    assert.equal(await statusOf(() => getPrompt('Büyük Harf', { dir })), 400);
  });

  test('geçersiz içerik 422 ve sorun listesi taşır', async () => {
    const dir = await library();
    await createPrompt({ title: 'Var', text: 'x' }, { dir });
    try {
      await updatePrompt('var', { tags: ['ses'] }, { dir });
      assert.fail('hata beklenmişti');
    } catch (error) {
      assert.equal(error.status, 422);
      assert.ok(error.details.problems.some((p) => p.includes('bilinmeyen etiket')));
    }
  });
});
