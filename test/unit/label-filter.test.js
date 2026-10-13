import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildLabelFilter, escapeFilterPath, labelFontPixels, positionExpressions } from '../../core/label-filter.js';
import { normalizeLabelPlan } from '../../core/label-plan.js';

const FONT = 'C:/Windows/Fonts/arial.ttf';
const SESSIONS = [
  { kind: 'status', name: 'STUDY', startSeconds: 0, endSeconds: 3000 },
  { kind: 'status', name: 'BREAK', startSeconds: 3000, endSeconds: 3600 },
  { kind: 'status', name: 'STUDY', startSeconds: 3600, endSeconds: 6600 },
];
const textPath = (name) => `C:\\tmp\\work\\${name}`;
const build = (raw, sessions = null) => buildLabelFilter({
  labels: normalizeLabelPlan(raw).labels, height: 720, fontFile: FONT, sessions, textPath,
});
const count = (text, needle) => text.split(needle).length - 1;

describe('buildLabelFilter', () => {
  test('etiket yoksa filter null — montaj eski davranışı sürdürür', () => {
    assert.equal(build([]).filter, null);
    assert.equal(build(undefined).filter, null);
  });

  test('serbest metin: textfile + expansion=none, zaman verilmediyse enable yok', () => {
    const { filter, files } = build([{ id: 'a', text: 'Merhaba 100% %{x}' }]);
    assert.equal(count(filter, 'drawtext='), 1);
    assert.match(filter, /expansion=none/);
    assert.match(filter, /textfile='C\\:\/tmp\/work\/label-a\.txt'/);
    assert.doesNotMatch(filter, /enable=/);
    // Metin filtreye GÖMÜLMEZ (özel karakter kaçışı riski yok), dosyaya gider.
    assert.doesNotMatch(filter, /Merhaba/);
    assert.deepEqual(files, [{ name: 'label-a.txt', content: 'Merhaba 100% %{x}' }]);
  });

  test('aralıklı metin yalnızca kendi aralığında görünür', () => {
    const { filter } = build([{ id: 'a', text: 'x', start: 5, end: 12 }]);
    assert.match(filter, /enable='between\(t,5,12\)'/);
  });

  test('konum: merkez + kenara kıstırma; boyut yüksekliğin oranı', () => {
    const pos = positionExpressions({ x: 0.25, y: 0.75 });
    assert.equal(pos.x, 'max(0,min(w-text_w,w*0.25-text_w/2))');
    assert.equal(pos.y, 'max(0,min(h-text_h,h*0.75-text_h/2))');
    assert.equal(labelFontPixels(0.05, 720), 36);
    assert.equal(labelFontPixels(0.02, 100), 8, 'en az 8 px');
    assert.match(build([{ id: 'a', text: 'x', size: 0.1 }]).filter, /fontsize=72/);
  });

  test('renk ve font filtreye yazılır, Windows yolu kaçışlanır', () => {
    const { filter } = build([{ id: 'a', text: 'x', color: '#ff8800' }]);
    assert.match(filter, /fontcolor=#ff8800/);
    assert.match(filter, /fontfile='C\\:\/Windows\/Fonts\/arial\.ttf'/);
    assert.equal(escapeFilterPath('C:\\Windows\\Fonts\\a b.ttf'), 'C\\:/Windows/Fonts/a b.ttf');
  });

  test('Pomodoro kapalıyken (sessions null) sistem etiketleri atlanır ve RAPORLANIR', () => {
    const result = build([
      { id: 's', kind: 'pomodoro-status' },
      { id: 'c', kind: 'pomodoro-countdown' },
    ], null);
    assert.equal(result.filter, null);
    assert.equal(result.skipped.length, 2);
    assert.match(result.skipped[0], /Pomodoro kapalı/);
  });

  test('durum yazısı: oturum başına bir drawtext, yalnızca kendi aralığında; ad başına bir metin dosyası', () => {
    const { filter, files } = build([{ id: 's', kind: 'pomodoro-status' }], SESSIONS);
    assert.equal(count(filter, 'drawtext='), SESSIONS.length);
    assert.match(filter, /enable='between\(t,0,3000\)'/);
    assert.match(filter, /enable='between\(t,3000,3600\)'/);
    assert.deepEqual(files, [
      { name: 'label-s-status-1.txt', content: 'STUDY' },
      { name: 'label-s-status-2.txt', content: 'BREAK' },
    ]);
    // aynı adlı oturumlar aynı dosyayı paylaşır
    const drawtexts = filter.split(',drawtext=');
    assert.match(drawtexts[0], /label-s-status-1\.txt/);
    assert.match(drawtexts[1], /label-s-status-2\.txt/);
    assert.match(drawtexts[2], /label-s-status-1\.txt/);
  });

  test('GET READY ve özel durum adları yazıya olduğu gibi gelir (yalnızca geçen adlar için dosya yazılır)', () => {
    const sessions = [{ name: 'GET READY', startSeconds: 0, endSeconds: 120 }, ...SESSIONS.map((s) => ({
      ...s, startSeconds: s.startSeconds + 120, endSeconds: s.endSeconds + 120,
    }))];
    const { filter, files } = build([{ id: 's', kind: 'pomodoro-status' }], sessions);
    assert.deepEqual(files.map((f) => f.content), ['GET READY', 'STUDY', 'BREAK']);
    assert.match(filter.split(',drawtext=')[0], /label-s-status-1\.txt/);
    assert.match(filter, /enable='between\(t,0,120\)'/);
  });

  test('yeni bir durum adı (STRETCH, Türkçe harfli) kendi dosyasına yazılır', () => {
    const sessions = [
      { name: 'STUDY', startSeconds: 0, endSeconds: 600 },
      { name: 'ESNEME ŞİMDİ', startSeconds: 600, endSeconds: 900 },
    ];
    const { filter, files } = build([{ id: 's', kind: 'pomodoro-status' }], sessions);
    assert.deepEqual(files.map((f) => f.content), ['STUDY', 'ESNEME ŞİMDİ']);
    assert.ok(!filter.includes('ŞİMDİ'), 'ad filtreye değil dosyaya yazılır (kaçış sorunu olmasın)');
  });

  test('geri sayım: oturumun bitişine göre ifade, oturum başına bir drawtext', () => {
    const { filter, files } = build([{ id: 'c', kind: 'pomodoro-countdown' }], SESSIONS);
    assert.equal(count(filter, 'drawtext='), SESSIONS.length);
    assert.match(filter, /ceil\(3000-t\)/);
    assert.match(filter, /ceil\(6600-t\)/);
    assert.deepEqual(files, [], 'sayaç dosya yazmaz, metni ffmpeg hesaplar');
  });

  test('konum değişince YALNIZCA konum ifadesi değişir; zaman/metin aynı kalır (görsel ile zamanlama ayrı)', () => {
    const a = build([{ id: 's', kind: 'pomodoro-status', x: 0.1, y: 0.1 }], SESSIONS).filter;
    const b = build([{ id: 's', kind: 'pomodoro-status', x: 0.8, y: 0.9 }], SESSIONS).filter;
    assert.notEqual(a, b);
    const strip = (text) => text.replace(/x='[^']*'/g, 'x=?').replace(/y='[^']*'/g, 'y=?');
    assert.equal(strip(a), strip(b));
  });

  test('sistem + serbest etiketler birlikte: serbest metin sistem etiketine karışmaz', () => {
    const { filter } = build([
      { id: 'a', text: 'Merhaba' },
      { id: 's', kind: 'pomodoro-status' },
    ], SESSIONS);
    assert.equal(count(filter, 'drawtext='), 1 + SESSIONS.length);
  });
});
