/**
 * test/helpers/fake-prompter.js — yardımcının kendisi yanlış yanıtta sessiz kalmamalı.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PromptClosedError } from '../../ui/prompt.js';
import { BACK, createFakePrompter, pick, picks } from '../helpers/fake-prompter.js';

const items = [
  { label: 'anime-cel — öneri', value: 'A' },
  { label: 'bozuk (geçersiz)', value: 'B', disabled: true },
  { label: 'cozy-realistic', value: 'C' },
];

describe('createFakePrompter', () => {
  test('değer yanıtları: ask, choose (etiket/değer/zero), chooseMany liste sırasında, confirm, BACK', async () => {
    const p = createFakePrompter([
      '  ad  ', pick('cozy'), pick('A'), pick('Geri'), picks('cozy', 'anime'), true, BACK, BACK, BACK,
    ]);
    assert.equal(await p.ask('İsim'), 'ad');
    assert.equal(await p.choose('Stil', items), 'C');
    assert.equal(await p.choose('Stil', items), 'A');
    assert.equal(await p.choose('Stil', items, { zeroLabel: 'Geri' }), null);
    assert.deepEqual(await p.chooseMany('Çok', items), ['A', 'C']);
    assert.equal(await p.confirm('Devam?'), true);
    assert.equal(await p.ask('İsim'), null);
    assert.equal(await p.choose('Stil', items), null);
    assert.equal(await p.confirm('Devam?'), false);
    assert.ok(p.output().includes('? Stil\n  - anime-cel — öneri\n  - bozuk (geçersiz) (seçilemez)\n'));
    assert.deepEqual(p.questions.map((q) => q.kind).slice(0, 3), ['ask', 'choose', 'choose']);
  });

  test('fonksiyon yanıtı soruyu ve seçenekleri görür', async () => {
    const p = createFakePrompter([({ kind, items: seen }) => {
      assert.equal(kind, 'choose');
      assert.equal(seen.length, 3);
      return pick('anime');
    }]);
    assert.equal(await p.choose('Stil', items), 'A');
  });

  test('anlaşılır hatalar: yanıt yok, tür uyuşmuyor, seçenek yok, devre dışı', async () => {
    await assert.rejects(createFakePrompter().ask('İsim'), /yanıt kalmadı: ask "İsim"/);
    await assert.rejects(createFakePrompter([true]).choose('Stil', items), /choose "Stil" için uygun olmayan yanıt: true/);
    await assert.rejects(createFakePrompter([pick('x')]).ask('İsim'), /ask "İsim" için uygun olmayan/);
    await assert.rejects(createFakePrompter([pick('watercolor')]).choose('Stil', items), /seçeneklerinde yok: anime-cel/);
    await assert.rejects(createFakePrompter([pick('bozuk')]).choose('Stil', items), /devre dışı seçeneği gösteriyor/);
  });

  test('closeWhenEmpty → PromptClosedError; boş liste soru sormadan null', async () => {
    const p = createFakePrompter([], { closeWhenEmpty: true });
    assert.equal(await p.choose('Boş', []), null);
    await assert.rejects(p.choose('Menü', items), PromptClosedError);
  });
});
