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

describe('gerçek klavye yolu (sahte TTY) — enquirer #483 Ctrl+C çökmesi', () => {
  const ESC = String.fromCharCode(27);
  const CTRL_C = String.fromCharCode(3);
  const DOWN = `${ESC}[B`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** show:true — enquirer keypress.listen ile gerçek readline açar; raw mode izlenir. */
  function ttyPrompter() {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (on) => { stdin.isRaw = Boolean(on); return stdin; };
    const stdout = new PassThrough();
    stdout.resume();
    return { stdin, prompter: createPrompter({ stdin, stdout }) };
  }

  /** Test süresince işlenmemiş reddetmeleri toplar (Node varsayılanı süreci çökertir). */
  function watchUnhandled(t) {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason?.code ?? String(reason));
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    return seen;
  }

  test('Select + Ctrl+C → PromptClosedError; ERR_USE_AFTER_CLOSE yok; raw mode kapalı', async (t) => {
    const unhandled = watchUnhandled(t);
    const { stdin, prompter } = ttyPrompter();
    const answer = prompter.choose('Menü:', items);
    const rejected = assert.rejects(answer, PromptClosedError);
    await wait(50);
    assert.equal(stdin.isRaw, true, 'prompt açıkken raw mode');
    stdin.write(CTRL_C);
    await rejected;
    await wait(50);
    assert.deepEqual(unhandled, []);
    assert.equal(stdin.isRaw, false, 'Ctrl+C sonrası terminal raw modda kalmamalı');
  });

  test('Input + Ctrl+C → PromptClosedError, çökme yok', async (t) => {
    const unhandled = watchUnhandled(t);
    const { stdin, prompter } = ttyPrompter();
    const rejected = assert.rejects(prompter.ask('Ad'), PromptClosedError);
    await wait(50);
    stdin.write('ab');
    stdin.write(CTRL_C);
    await rejected;
    await wait(50);
    assert.deepEqual(unhandled, []);
    assert.equal(stdin.isRaw, false);
  });

  test('Esc → geri, sonra aynı stdin\'de yeni soru çalışır (↓ Enter), raw mode her seferinde kapanır', async (t) => {
    const unhandled = watchUnhandled(t);
    const { stdin, prompter } = ttyPrompter();

    const first = prompter.choose('X', items);
    await wait(50);
    stdin.write(ESC); // tek ESC: readline kaçış dizisi zaman aşımını bekler
    assert.equal(await first, null);
    assert.equal(stdin.isRaw, false);

    const second = prompter.choose('Y', items);
    await wait(50);
    stdin.write(DOWN);
    await wait(20);
    stdin.write('\r');
    assert.deepEqual(await second, { id: 'C' });
    await wait(20);
    assert.equal(stdin.isRaw, false);
    assert.deepEqual(unhandled, []);
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
