/**
 * Aşama 10a — ui/tui (Screen + store + widgets) ink-testing-library ile:
 * TTY'siz, kare metin olarak okunur, tuşlar stdin.write ile basılır.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Box, Text } from 'ink';
import { render } from 'ink-testing-library';

import { PromptClosedError } from '../../ui/prompt.js';
import { ambientLabel } from '../../ui/tui/dashboard-view.js';
import { h } from '../../ui/tui/h.js';
import { BACK } from '../../ui/tui/keys.js';
import { Screen } from '../../ui/tui/screen.js';
import { createTuiStore } from '../../ui/tui/store.js';
import { ListView, ProgressBar, TextInputView } from '../../ui/tui/widgets.js';

const ESC = String.fromCharCode(27);
const KEY = { down: `${ESC}[B`, up: `${ESC}[A`, enter: '\r', esc: ESC, space: ' ', backspace: String.fromCharCode(127), ctrlC: String.fromCharCode(3) };
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const plain = (frame) => (frame ?? '').replace(ANSI, '');
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function press(stdin, ...keys) {
  for (const key of keys) {
    stdin.write(key);
    await tick();
  }
}

function mount(initial) {
  const store = createTuiStore(initial);
  const view = render(h(Screen, { store }));
  return { store, ...view, frame: () => plain(view.lastFrame()) };
}

describe('widgets', () => {
  test('ProgressBar: %50 ve 20 hücre → 10 dolu; classic karakterler; aralık dışı kırpılır', () => {
    const bar = (props) => plain(render(h(ProgressBar, { width: 20, ...props })).lastFrame());
    assert.equal(bar({ ratio: 0.5, label: '[04] ' }), `[04] ${'█'.repeat(10)}${'░'.repeat(10)}  50%`);
    assert.equal(bar({ ratio: 0.25, classic: true, suffix: '1:00 / 4:00' }), `${'#'.repeat(5)}${'-'.repeat(15)}  25% 1:00 / 4:00`);
    assert.equal(bar({ ratio: 7 }), `${'█'.repeat(20)} 100%`);
    assert.equal(bar({ ratio: Number.NaN }), `${'░'.repeat(20)}   0%`);
  });

  test('ListView: pencere, işaretçi, [x]/[ ], seçilemez ipucu, kaydırma satırları', () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ label: `Öğe ${i + 1}`, disabled: i === 3, hint: i === 3 ? '(çıktı var)' : undefined }));
    const frame = plain(render(h(ListView, { items, state: { cursor: 4, offset: 2, limit: 5, checked: [2] }, multi: true })).lastFrame());
    assert.equal(frame, [
      '  ... yukarıda 2 öğe',
      '  [x] Öğe 3',
      '  [ ] Öğe 4 (çıktı var)',
      '> [ ] Öğe 5',
      '  [ ] Öğe 6',
      '  [ ] Öğe 7',
      '  ... aşağıda 8 öğe',
    ].join('\n'));
  });

  test('TextInputView: imleç ortada ve sonda; boşken yer tutucu', () => {
    assert.equal(plain(render(h(TextInputView, { state: { value: 'ğüş', cursor: 1 } })).lastFrame()), 'ğüş');
    assert.match(plain(render(h(TextInputView, { state: { value: 'ab', cursor: 2 } })).lastFrame()), /^ab ?$/);
    assert.equal(plain(render(h(TextInputView, { state: { value: '', cursor: 0 }, placeholder: 'yol' })).lastFrame()), ' yol');
  });

  test('h(): çerçeveli kutu ve renk kodu', () => {
    const raw = render(h(Box, { borderStyle: 'round', borderColor: 'cyan' }, h(Text, { color: '#ff8800' }, 'lofi'))).lastFrame();
    assert.match(plain(raw), /^╭─+╮\n│lofi\s+│\n╰─+╯$/);
    assert.ok(raw.length > 0);
  });
});

describe('Screen + store', () => {
  test('sabit başlık, günlük, çubuklar ve kısayol satırı çiziliyor', async () => {
    const { store, frame, unmount } = mount({ header: { title: 'video3-Neo Tokyo Night', step: 'Faz 3 — Klip' } });
    store.log('build başladı');
    store.log('dikkat', 'warn');
    store.set({ bars: [{ label: '[04] ', ratio: 0.5, color: 'cyan' }] });
    await tick();
    const text = frame();
    assert.match(text, /lofi\s+video3-Neo Tokyo Night\s+Faz 3 — Klip/);
    assert.ok(text.includes('Günlük') && text.includes('build başladı') && text.includes('dikkat'));
    assert.ok(text.includes('[04] ') && text.includes('50%'));
    assert.ok(text.trimEnd().endsWith('Ctrl+C çık'));
    unmount();
  });

  test('select: ↓↓ Enter → değer; soru kapanır; kısayol satırı soruya göre', async () => {
    const { store, stdin, frame, unmount } = mount();
    const answer = store.request({ kind: 'select', title: 'Stil seç:', items: ['a', 'b', 'c'].map((x) => ({ label: x, value: x })) });
    await tick();
    assert.ok(frame().includes('Stil seç:') && frame().includes('> a'));
    assert.ok(frame().includes('↑↓ gez · Enter seç · Esc geri'));
    await press(stdin, KEY.down, KEY.down, KEY.enter);
    assert.equal(await answer, 'c');
    await tick();
    assert.ok(!frame().includes('Stil seç:'));
    unmount();
  });

  test('multi: Boşluk ↓↓ Boşluk Enter → liste sırasında', async () => {
    const { store, stdin, unmount } = mount();
    const answer = store.request({ kind: 'multi', title: 'Seç:', items: ['a', 'b', 'c'].map((x) => ({ label: x, value: x })) });
    await tick();
    await press(stdin, KEY.space, KEY.down, KEY.down, KEY.space, KEY.enter);
    assert.deepEqual(await answer, ['a', 'c']);
    unmount();
  });

  test('text: Türkçe + Backspace; ardışık iki soru durum sıfırlanarak', async () => {
    const { store, stdin, unmount } = mount();
    const first = store.request({ kind: 'text', title: 'Ad:' });
    await tick();
    await press(stdin, 'ğüşıöçx', KEY.backspace, KEY.enter);
    assert.equal(await first, 'ğüşıöç');

    const second = store.request({ kind: 'text', title: 'Tekrar:', initial: 'eski' });
    await tick();
    await press(stdin, KEY.enter);
    assert.equal(await second, 'eski');
    unmount();
  });

  test('Esc → BACK', async () => {
    const { store, stdin, unmount } = mount();
    const answer = store.request({ kind: 'select', title: 'X', items: [{ label: 'a', value: 'a' }] });
    await tick();
    await press(stdin, KEY.esc);
    assert.equal(await answer, BACK);
    unmount();
  });

  test('Ctrl+C: bekleyen soru PromptClosedError, sonraki sorular da reddedilir', async () => {
    const { store, stdin, unmount } = mount();
    const answer = store.request({ kind: 'select', title: 'X', items: [{ label: 'a', value: 'a' }] });
    const rejected = assert.rejects(answer, PromptClosedError); // tuştan önce bağlanmalı: reddetme tuş anında olur
    await tick();
    await press(stdin, KEY.ctrlC);
    await rejected;
    await assert.rejects(store.request({ kind: 'text', title: 'Y' }), PromptClosedError);
    unmount();
  });

  test('onKey genel tuşu yakalar; true dönerse soruya gitmez', async () => {
    const { store, stdin, unmount } = mount();
    const seen = [];
    store.set({ onKey: (input, key, widget) => { seen.push([input, widget?.kind ?? null]); return input === 'x'; } });
    const answer = store.request({ kind: 'text', title: 'Ad:' });
    await tick();
    await press(stdin, 'x', 'y', KEY.enter);
    assert.equal(await answer, 'y');
    assert.deepEqual(seen.slice(0, 2), [['x', 'text'], ['y', 'text']]);
    unmount();
  });

  test('aynı anda ikinci soru reddedilir', async () => {
    const { store, unmount } = mount();
    const first = assert.rejects(store.request({ kind: 'text', title: 'A' }), PromptClosedError);
    await assert.rejects(store.request({ kind: 'text', title: 'B' }), /aynı anda tek soru/);
    store.close();
    await first;
    unmount();
  });
});

describe('taşan içerik', () => {
  test('üst içerik ekrana sığmasa da menü öğeleri ezilmez, hepsi ayrı satırda görünür', async () => {
    const store = createTuiStore();
    const tallBody = () => h(Box, { flexDirection: 'column' }, ...Array.from({ length: 60 }, (_, i) => h(Text, { key: i }, `satır ${i}`)));
    const view = render(h(Screen, { store, body: tallBody }));
    const labels = ['📂 [ Klasörü Aç ] - Resim Klasörünü Windows\'ta Aç', '🔄 [ Yenile ] - Klasörü Yeniden Tara', '🏠 Ana Menüye Dön'];
    const answer = store.request({ kind: 'select', title: 'MASTER FRAME READY', items: labels.map((label, i) => ({ label, value: i })) });
    await tick();
    const lines = plain(view.lastFrame()).split('\n');
    for (const label of labels) {
      assert.equal(lines.filter((line) => line.includes(label)).length, 1, `görünmüyor ya da ezilmiş: ${label}`);
    }
    store.close();
    await assert.rejects(answer, PromptClosedError);
    view.unmount();
  });
});

test('ambientLabel: tam yollar dosya adına kısalır', () => {
  assert.equal(ambientLabel('C:\\Users\\A B\\ortak-ses efektleri\\gentleRain.mp3,C:\\x\\campfire.mp3'), 'gentleRain, campfire');
  assert.equal(ambientLabel('gentleRain'), 'gentleRain');
  assert.equal(ambientLabel('none'), 'none');
  assert.equal(ambientLabel(undefined), 'none');
});
