/**
 * ui/prompt.js — PassThrough akışlarıyla soru/seçim/onay ve yol temizleme.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { PromptClosedError, cleanPath, createPrompter } from '../../ui/prompt.js';

/** Yanıtlar baştan yazılır; çıktı metin olarak toplanır. */
function scripted(...answers) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  if (answers.length > 0) input.write(answers.map((a) => `${a}\n`).join(''));
  const prompter = createPrompter({ input, output });
  return { prompter, input, output: () => text };
}

describe('createPrompter', () => {
  test('sorulardan önce yazılan yanıtlar sırayla alınır', async () => {
    const { prompter } = scripted('bir', '  iki  ', 'üç');
    assert.equal(await prompter.ask('A'), 'bir');
    assert.equal(await prompter.ask('B'), 'iki');
    assert.equal(await prompter.ask('C'), 'üç');
    prompter.close();
  });

  test('ask: boş girişte varsayılan, soru metninde gösterilir', async () => {
    const { prompter, output } = scripted('', 'yeni');
    assert.equal(await prompter.ask('İsim', { defaultValue: 'eski' }), 'eski');
    assert.equal(await prompter.ask('İsim', { defaultValue: 'eski' }), 'yeni');
    assert.ok(output().includes('İsim [eski]: '));
    prompter.close();
  });

  test('choose: geçersiz ve seçilemez girişte tekrar sorar, geçerli değeri döner', async () => {
    const { prompter, output } = scripted('9', 'abc', '2', '3');
    const value = await prompter.choose('Stil', [
      { label: 'a', value: 'A' },
      { label: 'b (geçersiz)', value: 'B', disabled: true },
      { label: 'c', value: 'C' },
    ]);
    assert.equal(value, 'C');
    const text = output();
    assert.ok(text.includes('Stil\n  1) a\n  2) b (geçersiz)\n  3) c\n'));
    assert.equal(text.split('1–3 arası bir numara gir.').length - 1, 2);
    assert.ok(text.includes('2) seçilemez.'));
    prompter.close();
  });

  test('choose: 0 → null yalnızca zeroLabel varsa', async () => {
    const { prompter, output } = scripted('0', '0', '1');
    assert.equal(await prompter.choose('X', [{ label: 'a', value: 1 }], { zeroLabel: 'geri' }), null);
    assert.ok(output().includes('  0) geri\n'));
    assert.equal(await prompter.choose('Y', [{ label: 'a', value: 1 }]), 1);
    assert.ok(output().includes('1–1 arası bir numara gir.'));
    prompter.close();
  });

  test('choose: boş liste ve zeroLabel yok → soru sorulmadan null', async () => {
    const { prompter, output } = scripted();
    assert.equal(await prompter.choose('Boş', []), null);
    assert.equal(output(), '');
    prompter.close();
  });

  test('confirm: varsayılan, e/h biçimleri, geçersizde tekrar', async () => {
    const { prompter, output } = scripted('', '', 'EVET', 'hayır', 'belki', 'y');
    assert.equal(await prompter.confirm('Devam?'), false);
    assert.equal(await prompter.confirm('Devam?', { defaultValue: true }), true);
    assert.equal(await prompter.confirm('Devam?'), true);
    assert.equal(await prompter.confirm('Devam?', { defaultValue: true }), false);
    assert.equal(await prompter.confirm('Devam?'), true);
    const text = output();
    assert.ok(text.includes('Devam? [e/H] ') && text.includes('Devam? [E/h] '));
    assert.ok(text.includes('e ya da h gir.'));
    prompter.close();
  });

  test('EOF: kuyruktaki satır teslim edilir, sonra PromptClosedError', async () => {
    const { prompter, input } = scripted('son');
    input.end();
    assert.equal(await prompter.ask('A'), 'son');
    await assert.rejects(prompter.ask('B'), PromptClosedError);
  });

  test('bekleyen soru giriş kapanınca reddedilir', async () => {
    const { prompter, input } = scripted();
    const pending = prompter.ask('A');
    input.end();
    await assert.rejects(pending, PromptClosedError);
  });

  test('suspend/resume: askıdayken gelen satır kaybolmaz, kapanış sayılmaz', async () => {
    const { prompter, input } = scripted('önce');
    assert.equal(await prompter.ask('A'), 'önce');
    prompter.suspend();
    input.write('askıdayken\n');
    prompter.resume();
    assert.equal(await prompter.ask('B'), 'askıdayken');
    prompter.close();
    await assert.rejects(prompter.ask('C'), PromptClosedError);
  });
});

describe('cleanPath', () => {
  for (const [raw, expected] of [
    ['"C:\\Users\\a b\\x.jpg"', 'C:\\Users\\a b\\x.jpg'],
    ["'C:\\a b.png'", 'C:\\a b.png'],
    ["& 'C:\\a b.png'", 'C:\\a b.png'],
    ['  C:\\duz.jpg  ', 'C:\\duz.jpg'],
    ['"yarım', '"yarım'],
    ['&isim.jpg', '&isim.jpg'],
    ['', ''],
  ]) {
    test(`${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => assert.equal(cleanPath(raw), expected));
  }
});
