/**
 * ui/prompt.js — gerçek enquirer ile. show:false: klavye dinlenmez, tuşlar
 * prompt.keypress ile basılır (enquirer'ın hazır test yardımcısı yok; TTY
 * olmayan stdin kabul etmiyor). stdout yutucu akış: imleç kodları terminale
 * yazılmasın.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';

import { PromptClosedError, cleanPath, createPrompter } from '../../ui/prompt.js';

/** Tuş adları: 'down' 'up' 'space' 'backspace' 'escape' 'ctrl+c' ya da { type: 'metin' }. */
async function press(prompt, key) {
  if (typeof key === 'object') {
    for (const ch of key.type) await prompt.keypress(ch, { name: ch === ' ' ? 'space' : ch });
  } else if (key === 'ctrl+c') {
    await prompt.keypress('\x03', { name: 'c', ctrl: true });
  } else if (key === 'space') {
    await prompt.keypress(' ', { name: 'space' });
  } else {
    await prompt.keypress(null, { name: key });
  }
}

/**
 * Her prompt için bir tuş dizisi. Dizide escape / ctrl+c yoksa sonunda Enter (submit).
 * @param {(string | { type: string })[][]} script
 */
function scripted(script) {
  const queue = [...script];
  const prompts = [];
  const stdout = new PassThrough();
  let text = '';
  stdout.on('data', (chunk) => { text += chunk; });

  const prompter = createPrompter({
    stdout,
    show: false,
    onPrompt(prompt) {
      const keys = queue.shift();
      if (!keys) throw new Error('beklenmeyen prompt');
      prompts.push(prompt);
      prompt.once('run', async () => {
        for (const key of keys) await press(prompt, key);
        if (!keys.includes('escape') && !keys.includes('ctrl+c')) await prompt.submit();
      });
    },
  });
  return { prompter, prompts, output: () => text };
}

const items = [
  { label: 'anime-cel', value: { id: 'A' } },
  { label: 'bozuk', value: { id: 'B' }, disabled: true },
  { label: 'cozy-realistic', value: { id: 'C' } },
];

describe('choose (Select)', () => {
  test('↓ Enter → değer (ad değil); devre dışı öğe atlanır; liste sınırı 10', async () => {
    const { prompter, prompts } = scripted([['down']]);
    assert.deepEqual(await prompter.choose('Stil seç:', items), { id: 'C' });
    assert.equal(prompts[0].options.limit, 10);
    assert.deepEqual(prompts[0].options.choices.map((c) => c.message), ['anime-cel', 'bozuk', 'cozy-realistic']);
    // enquirer normalleştirir: disabled metni hint'e taşınır (varsayılan İngilizce "(disabled)").
    assert.equal(prompts[0].options.choices[1].disabled, true);
    assert.equal(prompts[0].options.choices[1].hint, '(seçilemez)');
  });

  test('zeroLabel en sonda; seçilirse null', async () => {
    const { prompter, prompts } = scripted([['down', 'down']]);
    assert.equal(await prompter.choose('Stil seç:', items, { zeroLabel: 'Geri' }), null);
    assert.equal(prompts[0].options.choices.at(-1).message, 'Geri');
  });

  test('Esc → null; Ctrl+C → PromptClosedError', async () => {
    const esc = scripted([['escape']]);
    assert.equal(await esc.prompter.choose('X', items), null);
    const ctrlC = scripted([['ctrl+c']]);
    await assert.rejects(ctrlC.prompter.choose('X', items), PromptClosedError);
  });

  test('çok satırlı başlık: önceki satırlar basılır, son satır soru', async () => {
    const { prompter, prompts, output } = scripted([[]]);
    await prompter.choose('\nlofi — üretim paneli\nProje: v — sıradaki: Faz 1', items);
    // show:false'ta bile enquirer imleç gizle/göster kodlarını yazar.
    assert.equal(output().replace(/\x1b\[\?25[lh]/g, ''), '\nlofi — üretim paneli\n');
    assert.equal(prompts[0].options.message, 'Proje: v — sıradaki: Faz 1');
  });

  test('boş liste ve zeroLabel yok → prompt açılmadan null', async () => {
    const { prompter, prompts } = scripted([]);
    assert.equal(await prompter.choose('Boş', []), null);
    assert.equal(prompts.length, 0);
  });

  test('gerçek hata PromptClosedError\'a çevrilmez', async () => {
    const prompter = createPrompter({
      stdout: new PassThrough(),
      show: false,
      onPrompt(prompt) { prompt.run = async () => { throw new Error('gerçek hata'); }; },
    });
    await assert.rejects(prompter.choose('X', items), /gerçek hata/);
  });
});

describe('ask (Input)', () => {
  test('yazılan metin kırpılır; Türkçe karakter; Backspace', async () => {
    const { prompter } = scripted([[{ type: '  ğüşıöç yolx' }, 'backspace', { type: ' ' }]]);
    assert.equal(await prompter.ask('Proje adı'), 'ğüşıöç yol');
  });

  test('boş Enter → varsayılan; Esc → null', async () => {
    const { prompter } = scripted([[], ['escape']]);
    assert.equal(await prompter.ask('İsim', { defaultValue: 'eski' }), 'eski');
    assert.equal(await prompter.ask('İsim'), null);
  });
});

describe('confirm (Evet/Hayır seçimi)', () => {
  test('varsayılan evet → Enter true; ↓ → false; varsayılan hayır → Enter false; Esc → false', async () => {
    const { prompter, prompts } = scripted([[], ['down'], [], ['escape']]);
    assert.equal(await prompter.confirm('Devam?', { defaultValue: true }), true);
    assert.equal(await prompter.confirm('Devam?', { defaultValue: true }), false);
    assert.equal(await prompter.confirm('Devam?'), false);
    assert.equal(await prompter.confirm('Devam?', { defaultValue: true }), false);
    assert.deepEqual(prompts[0].options.choices.map((c) => c.message), ['Evet', 'Hayır']);
  });

  test('Ctrl+C → PromptClosedError', async () => {
    const { prompter } = scripted([['ctrl+c']]);
    await assert.rejects(prompter.confirm('Devam?'), PromptClosedError);
  });
});

describe('chooseMany (MultiSelect)', () => {
  const many = [{ label: 'a', value: 1 }, { label: 'b', value: 2 }, { label: 'c', value: 3 }];

  test('Boşluk ↓↓ Boşluk → iki değer liste sırasında; gösterge [x]/[ ]', async () => {
    const { prompter, prompts } = scripted([['down', 'down', 'space', 'up', 'up', 'space']]);
    assert.deepEqual(await prompter.chooseMany('Seç:', many), [1, 3]);
    const { indicator } = prompts[0].options;
    assert.equal(indicator({}, { enabled: true }), '[x]');
    assert.equal(indicator({}, { enabled: false }), '[ ]');
  });

  test('hiçbiri işaretlenmeden Enter → []; Esc → null; boş liste → []', async () => {
    const { prompter } = scripted([[], ['escape']]);
    assert.deepEqual(await prompter.chooseMany('Seç:', many), []);
    assert.equal(await prompter.chooseMany('Seç:', many), null);
    assert.deepEqual(await prompter.chooseMany('Seç:', []), []);
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
