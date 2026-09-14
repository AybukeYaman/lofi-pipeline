#!/usr/bin/env node
/**
 * Aşama 10a — ink dashboard'unun bu terminalde çalıştığının elle doğrulaması
 * (kapı: 3 Windows terminalinde geçmeden panele ink alınmaz).
 *
 *   npm run tui-check
 *
 * Panelde kullanılacak parçaların kendisini sınar: ui/tui/screen.js (tek
 * merkezden girdi), keys.js, widgets.js, store.js ve alt süreçle IPC.
 */

import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Box, render, Text } from 'ink';

import { PromptClosedError } from '../ui/prompt.js';
import { REPO_ROOT } from '../ui/runner.js';
import { h } from '../ui/tui/h.js';
import { BACK } from '../ui/tui/keys.js';
import { Screen, WIDE_COLUMNS } from '../ui/tui/screen.js';
import { createTuiStore } from '../ui/tui/store.js';

const STEP_COUNT = 10;
const BAR_COLORS = { '02': 'magenta', '04': 'cyan', '03': 'green' };

function environment() {
  return [
    `Node: ${process.version} · platform: ${process.platform}`,
    `TERM_PROGRAM: ${process.env.TERM_PROGRAM ?? '(yok)'} · Windows Terminal (WT_SESSION): ${process.env.WT_SESSION ? 'evet' : 'hayır'}`,
    `stdin TTY: ${Boolean(process.stdin.isTTY)} · stdout TTY: ${Boolean(process.stdout.isTTY)} · setRawMode: ${typeof process.stdin.setRawMode === 'function'}`,
    `Boyut: ${process.stdout.columns ?? '?'} × ${process.stdout.rows ?? '?'}`,
  ].join('\n');
}

/** Soru yardımcıları (10c'de InkPrompter'a dönüşecek köprünün provası). */
function questions(store) {
  const choose = (title, labels) => store.request({
    kind: 'select', title, items: labels.map((label) => ({ label, value: label })),
  });
  return {
    choose,
    yes: async (title) => (await choose(title, ['Evet', 'Hayır'])) === 'Evet',
    many: (title, labels) => store.request({ kind: 'multi', title, items: labels.map((label) => ({ label, value: label })) }),
    ask: (title, placeholder) => store.request({ kind: 'text', title, placeholder }),
  };
}

/** Alt süreci IPC ile çalıştırır; ilerleme çubuklara, satırlar günlüğe. */
function runChild(store, mode, { onStart } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'tui-check-child.js'), mode], {
      cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const seen = { progress: 0, logs: [] };
    const bars = {};
    const onLine = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) store.log(`  ${line}`);
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('message', (message) => {
      if (message?.type === 'progress') {
        seen.progress += 1;
        bars[message.tag] = {
          label: `[${message.tag}] `,
          ratio: message.seconds / message.total,
          color: BAR_COLORS[message.tag],
          suffix: `${message.seconds.toFixed(1)} / ${message.total} sn`,
        };
        store.set({ bars: Object.values(bars) });
      } else if (message?.type === 'log') {
        seen.logs.push(message.message);
        store.log(message.message, message.level);
      }
    });
    child.on('error', (error) => store.log(`alt süreç başlatılamadı: ${error.message}`, 'error'));
    child.on('close', (code) => resolveRun({ code, ...seen }));
    onStart?.(child);
  });
}

/** Demo alanı (orta panelin üstü). */
function body(snap, size) {
  const demo = snap.demo;
  if (!demo) return null;
  if (demo === 'borders') {
    return h(Box, { gap: 2 },
      h(Box, { borderStyle: 'single', paddingX: 1 }, h(Text, null, 'single ─│┌┐')),
      h(Box, { borderStyle: 'classic', paddingX: 1 }, h(Text, null, 'classic +-|')));
  }
  if (demo === 'colors') {
    return h(Box, { gap: 1, flexWrap: 'wrap' },
      ...['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', '#ff8800']
        .map((color) => h(Text, { key: color, color }, `■ ${color}`)));
  }
  if (demo === 'size') {
    return h(Text, null, `Şu an: ${size.columns} × ${size.rows} — düzen: `,
      h(Text, { color: 'cyan' }, size.wide ? 'yan yana' : 'alt alta'),
      ` (eşik ${WIDE_COLUMNS} sütun)`);
  }
  return h(Text, { dimColor: true }, demo);
}

/** @returns {Promise<number>} 0 hepsi geçti · 1 en az biri kaldı · 2 terminal etkileşimli değil */
export async function main() {
  console.log(`${environment()}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Terminal etkileşimli değil — ink dashboard burada çalışamaz (Git Bash / yönlendirilmiş çıktıda beklenen durum).');
    return 2;
  }

  const store = createTuiStore({ header: { title: 'tui-check' } });
  const q = questions(store);
  const results = [];
  const record = (name, ok, note = '') => {
    results.push({ name, ok, note });
    store.log(`${ok ? '[x]' : '[ ]'} ${name}${note ? ` — ${note}` : ''}`, ok ? 'info' : 'warn');
  };

  const steps = [
    ['Çerçeve karakterleri', async () => {
      store.set({ demo: 'borders' });
      const answer = await q.choose('Yukarıdaki iki çerçeve nasıl görünüyor?', ['İkisi de düzgün', 'Yalnızca classic (+-|) düzgün', 'İkisi de bozuk']);
      return [answer !== 'İkisi de bozuk', answer];
    }],
    ['Renkler', async () => {
      store.set({ demo: 'colors' });
      return [await q.yes('Renkler birbirinden ayrı görünüyor mu (turuncu dahil)?'), ''];
    }],
    ['Liste + kaydırma', async () => {
      store.set({ demo: null });
      const items = Array.from({ length: 15 }, (_, i) => ({ label: `Öğe ${i + 1}`, value: i + 1 }));
      const chosen = await store.request({ kind: 'select', title: 'Oklarla "Öğe 12"ye in (liste kaymalı), Enter:', items });
      return [chosen === 12, `seçilen: ${typeof chosen === 'symbol' ? 'geri' : chosen}`];
    }],
    ['Çoklu seçim', async () => {
      const chosen = await q.many('Boşluk ile "b" ve "c"yi işaretle, Enter:', ['a', 'b', 'c', 'd']);
      const ok = JSON.stringify(chosen) === '["b","c"]';
      return [ok && await q.yes('İşaretliler [x], diğerleri [ ] görünüyordu mu?'), `seçilen: ${Array.isArray(chosen) ? chosen.join(',') : 'geri'}`];
    }],
    ['Metin (Türkçe, Backspace, yapıştırma)', async () => {
      const text = await q.ask('"ğüşıöç" yaz, Backspace ile bir harf sil, boşluklu bir yol yapıştır, Enter:', 'buraya yaz');
      if (text === BACK) return [false, 'Esc basıldı'];
      store.log(`  girilen: ${JSON.stringify(text)}`);
      return [await q.yes(`Girilen doğru mu? ${JSON.stringify(text)}`), ''];
    }],
    ['Esc → geri', async () => {
      const answer = await store.request({ kind: 'select', title: "Bu listede Esc'e bas (Enter'a basma):", items: [{ label: 'Esc bekleniyor', value: 'enter' }] });
      return [answer === BACK, answer === BACK ? '' : 'Enter basıldı'];
    }],
    ['Pencere boyutu', async () => {
      store.set({ demo: 'size' });
      const answer = await q.choose(`Pencereyi ${WIDE_COLUMNS} sütunun altına daralt ve geri genişlet. Paneller yeniden dizildi mi?`, ['Evet, dizildi', 'Hayır / bozuldu']);
      return [answer === 'Evet, dizildi', ''];
    }],
    ['Alt süreç ilerlemesi (IPC)', async () => {
      store.set({ demo: 'Alt süreç 5 sn çalışacak — çubukları ve günlüğü izle.' });
      const { code, progress } = await runChild(store, 'kisa');
      const ok = code === 0 && progress > 0;
      return [ok && await q.yes('Çubuklar ve günlük canlı güncellendi mi?'), `kod ${code}, ${progress} ilerleme mesajı`];
    }],
    ['İptal (IPC cancel)', async () => {
      store.set({ demo: "Alt süreç 30 sn çalışacak — 'x' ile iptal et.", bars: [], footer: 'x iptal · Ctrl+C çık' });
      let child;
      store.set({
        onKey: (input) => {
          if (input !== 'x' || !child?.connected) return false;
          child.send({ type: 'cancel' });
          store.log('iptal gönderildi', 'warn');
          return true;
        },
      });
      const run = await runChild(store, 'uzun', { onStart: (c) => { child = c; } });
      store.set({ onKey: null, footer: '' });
      const ok = run.code === 130 && run.logs.includes('temizlik bitti');
      return [ok, `kod ${run.code}${run.logs.includes('temizlik bitti') ? ', temizlik yapıldı' : ''}`];
    }],
  ];

  const instance = render(h(Screen, { store, body }), {
    alternateScreen: true, exitOnCtrlC: false, incrementalRendering: true, patchConsole: false,
  });

  let interrupted = false;
  try {
    for (const [index, [name, run]] of steps.entries()) {
      store.set({ header: { title: 'tui-check', step: `${index + 1}/${STEP_COUNT} ${name}` }, demo: null });
      const [ok, note] = await run();
      record(name, ok, note);
    }
    store.set({ header: { title: 'tui-check', step: `${STEP_COUNT}/${STEP_COUNT} Çıkış` }, demo: 'Son adım: Enter → dashboard kapanır, normal ekrana dönülür.', bars: [] });
    await q.choose('Çıkmak için Enter:', ['Çık']);
  } catch (error) {
    if (!(error instanceof PromptClosedError)) throw error;
    interrupted = true;
  }

  const exitedAt = Date.now();
  instance.unmount();
  await instance.waitUntilExit();
  const exitMs = Date.now() - exitedAt;
  results.push({ name: 'Çıkış (alternatif ekrandan dönüş)', ok: !interrupted && exitMs < 2000, note: interrupted ? 'Ctrl+C ile kesildi' : `${exitMs} ms` });

  const passed = results.filter((r) => r.ok).length;
  console.log([
    ...results.map((r) => `${r.ok ? '[x]' : '[ ]'} ${r.name}${r.note ? ` — ${r.note}` : ''}`),
    '',
    `Sonuç: ${passed}/${STEP_COUNT}${interrupted ? ' (yarıda kesildi)' : ''}`,
    `HANDOFF satırı: | ${process.env.TERM_PROGRAM ?? (process.env.WT_SESSION ? 'Windows Terminal' : 'konsol')} | ${results.map((r) => `${r.name}: ${r.ok ? 'geçti' : 'KALDI'}`).join(' · ')} |`,
    '',
    'Elle kontrol: dashboard açılmadan önceki terminal içeriği geri geldi mi? Şimdi bir şey yaz —',
    'harfler görünüyor ve imleç yanıp sönüyorsa terminal eski hâline dönmüştür.',
  ].join('\n'));

  // ink #943: Windows'ta çıkıştan sonra süreç asılı kalabiliyor. Olay döngüsü boşalırsa bu zamanlayıcı çalışmaz.
  setTimeout(() => {
    console.log('\nKALDI: süreç kendiliğinden kapanmadı (ink #943) — zorla kapatılıyor.');
    process.exit(1);
  }, 2000).unref();

  return passed === STEP_COUNT && !interrupted ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
