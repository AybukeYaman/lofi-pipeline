/**
 * ui/tui/keys.js — saf tuş mantığı (ink'siz).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BACK, initialList, initialText, multiSelectKey, selectKey, textKey, textPaste,
} from '../../ui/tui/keys.js';

const K = (patch = {}) => ({
  upArrow: false, downArrow: false, pageUp: false, pageDown: false, home: false, end: false,
  return: false, escape: false, backspace: false, delete: false, leftArrow: false, rightArrow: false,
  ctrl: false, meta: false, tab: false, ...patch,
});
const DOWN = K({ downArrow: true });
const UP = K({ upArrow: true });
const ENTER = K({ return: true });

/** Tuş dizisini uygular; ilk sonuçta durur. */
function run(fn, state, keys) {
  for (const [input, key] of keys) {
    const out = fn(state, input, key);
    state = out.state;
    if (out.result !== undefined) return { state, result: out.result };
  }
  return { state };
}

const items = (n, disabled = []) =>
  Array.from({ length: n }, (_, i) => ({ label: `Öğe ${i + 1}`, value: i + 1, disabled: disabled.includes(i) }));

describe('selectKey', () => {
  test('↓↓ Enter → üçüncü değer; sarmalama yok', () => {
    const list = items(3);
    const select = (s, input, key) => selectKey(s, list, input, key);
    assert.equal(run(select, initialList(list), [['', DOWN], ['', DOWN], ['', ENTER]]).result, 3);
    assert.equal(run(select, initialList(list), [['', UP], ['', ENTER]]).result, 1);
    assert.equal(run(select, initialList(list), [['', DOWN], ['', DOWN], ['', DOWN], ['', ENTER]]).result, 3);
  });

  test('devre dışı öğeler atlanır; ilk öğe devre dışıysa imleç ilk seçilebilirde başlar', () => {
    const list = items(4, [0, 2]);
    const start = initialList(list);
    assert.equal(start.cursor, 1);
    const select = (s, input, key) => selectKey(s, list, input, key);
    assert.equal(run(select, start, [['', DOWN], ['', ENTER]]).result, 4);
    assert.equal(run(select, start, [['', UP], ['', ENTER]]).result, 2);
  });

  test('hepsi devre dışıysa Enter sonuç vermez; Esc → BACK', () => {
    const list = items(2, [0, 1]);
    const start = initialList(list);
    assert.equal(start.cursor, -1);
    assert.equal(selectKey(start, list, '', ENTER).result, undefined);
    assert.equal(selectKey(start, list, '', K({ escape: true })).result, BACK);
  });

  test('kaydırma: limit 10, imleç pencerede kalır; PgDn / End / Home', () => {
    const list = items(15);
    let s = initialList(list);
    for (let i = 0; i < 11; i++) s = selectKey(s, list, '', DOWN).state;
    assert.deepEqual([s.cursor, s.offset], [11, 2]);
    s = selectKey(s, list, '', K({ end: true })).state;
    assert.deepEqual([s.cursor, s.offset], [14, 5]);
    s = selectKey(s, list, '', K({ home: true })).state;
    assert.deepEqual([s.cursor, s.offset], [0, 0]);
    s = selectKey(s, list, '', K({ pageDown: true })).state;
    assert.equal(s.cursor, 10);
  });
});

describe('multiSelectKey', () => {
  test('Boşluk işaretler/kaldırır; Enter liste sırasında; devre dışı işaretlenmez', () => {
    const list = items(4, [1]);
    const multi = (s, input, key) => multiSelectKey(s, list, input, key);
    const out = run(multi, initialList(list), [
      ['', K({ end: true })], [' ', K()], ['', K({ home: true })], [' ', K()], [' ', K()], [' ', K()], ['', ENTER],
    ]);
    assert.deepEqual(out.result, [1, 4]);
    assert.deepEqual(run(multi, initialList(list), [['', ENTER]]).result, []);
    assert.equal(multiSelectKey(initialList(list), list, '', K({ escape: true })).result, BACK);
  });
});

describe('textKey / textPaste', () => {
  const text = (s, input, key) => textKey(s, input, key);

  test('Türkçe karakter, Backspace, ←/→ ile araya ekleme, Delete', () => {
    const out = run(text, initialText(), [
      ['ğ', K()], ['ü', K()], ['ş', K()], ['x', K()], ['', K({ backspace: true })],
      ['', K({ leftArrow: true })], ['ı', K()], ['', K({ end: true })], ['', K({ home: true })], ['', K({ delete: true })], ['', ENTER],
    ]);
    assert.equal(out.result, 'üış');
  });

  test('varsayılan değer, kontrol tuşları metne eklenmez, Esc → BACK', () => {
    assert.equal(run(text, initialText('eski'), [['c', K({ ctrl: true })], ['', K({ tab: true })], ['', ENTER]]).result, 'eski');
    assert.equal(textKey(initialText('x'), '', K({ escape: true })).result, BACK);
    assert.deepEqual(textKey(initialText(), '', K({ backspace: true })).state, { value: '', cursor: 0 });
  });

  test('yapıştırma imleç konumuna eklenir, satır sonları atılır', () => {
    const { state } = textPaste({ value: 'ab', cursor: 1 }, 'C:\\a b\r\n.jpg');
    assert.deepEqual(state, { value: 'aC:\\a b.jpgb', cursor: 11 });
  });
});
