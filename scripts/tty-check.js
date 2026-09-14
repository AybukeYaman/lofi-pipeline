#!/usr/bin/env node
/**
 * Aşama 9d — terminal doğrulaması: enquirer'ın raw mode'u bu terminalde
 * güvenilir mi? Elle çalıştırılır, npm test'e dahil değil (raw mode otomatik
 * sınanamıyor).
 *
 *   npm run tty-check
 *
 * Panelin gerçek adaptörünü (ui/prompt.js) ve komut çalıştırıcısını
 * (ui/runner.js) kullanır. Sonuç satırı HANDOFF bölüm 12 tablosuna yazılır.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PromptClosedError, createPrompter } from '../ui/prompt.js';
import { runScript } from '../ui/runner.js';

function environment() {
  return [
    `Node: ${process.version} · platform: ${process.platform}`,
    `TERM_PROGRAM: ${process.env.TERM_PROGRAM ?? '(yok)'} · Windows Terminal (WT_SESSION): ${process.env.WT_SESSION ? 'evet' : 'hayır'}`,
    `stdin TTY: ${Boolean(process.stdin.isTTY)} · stdout TTY: ${Boolean(process.stdout.isTTY)} · setRawMode: ${typeof process.stdin.setRawMode === 'function'}`,
    `Boyut: ${process.stdout.columns ?? '?'} × ${process.stdout.rows ?? '?'}`,
  ].join('\n');
}

/** @returns {Promise<number>} 0 hepsi geçti · 1 en az biri geçmedi · 2 terminal etkileşimli değil */
export async function main() {
  console.log(`${environment()}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Terminal etkileşimli değil — enquirer burada çalışamaz (Git Bash / yönlendirilmiş çıktıda beklenen durum).');
    return 2;
  }

  const p = createPrompter();
  const looksRight = (question) => p.confirm(question, { defaultValue: true });

  const steps = [
    ['Select + kaydırma', async () => {
      const items = Array.from({ length: 15 }, (_, i) => ({ label: `Öğe ${i + 1}`, value: i + 1 }));
      const chosen = await p.choose('1/6 Oklarla "Öğe 12"ye in (liste kaydırılmalı), Enter:', items);
      return [chosen === 12, `seçilen: ${chosen}`];
    }],
    ['MultiSelect [x]/[ ]', async () => {
      const chosen = await p.chooseMany('2/6 Boşluk ile "b" ve "c"yi işaretle, Enter:', ['a', 'b', 'c', 'd'].map((x) => ({ label: x, value: x })));
      const ok = JSON.stringify(chosen) === '["b","c"]' && await looksRight('İşaretliler [x], diğerleri [ ] görünüyor muydu?');
      return [ok, `seçilen: ${JSON.stringify(chosen)}`];
    }],
    ['Input (Türkçe, Backspace, yapıştırma)', async () => {
      const text = await p.ask('3/6 "ğüşıöç" yaz, Backspace ile bir harf sil, sonra boşluklu bir yol yapıştır');
      p.print(`  girilen: ${JSON.stringify(text)}`);
      return [text !== null && await looksRight('Girilen metin doğru mu?'), ''];
    }],
    ['Esc → geri', async () => {
      const answer = await p.choose('4/6 Bu listede Esc\'e bas (Enter\'a basma):', [{ label: 'Esc bekleniyor', value: 'enter' }]);
      return [answer === null, answer === null ? '' : 'Enter basıldı'];
    }],
    ['Alt süreç devri', async () => {
      p.print('5/6 Alt süreç açılıyor (build.js\'in kırpma onayına benzer bir soru):');
      const code = await runScript('scripts/tty-check-child.js');
      const arrows = await p.choose('Alt süreçten dönüldü. Oklarla "Evet, çalışıyor"a gel, Enter:', [
        { label: 'Oklar çalışmıyor', value: false },
        { label: 'Evet, çalışıyor', value: true },
      ]);
      return [code === 0 && arrows === true, `alt süreç kodu ${code}`];
    }],
  ];

  const results = [];
  const record = (name, ok, note) => {
    results.push({ name, ok });
    p.print(`${ok ? '[x]' : '[ ]'} ${name}${note ? ` — ${note}` : ''}\n`);
  };

  for (const [name, run] of steps) {
    try {
      const [ok, note] = await run();
      record(name, ok, note);
    } catch (error) {
      if (!(error instanceof PromptClosedError)) throw error;
      record(name, false, 'Ctrl+C ile yarıda kesildi');
      return summary(results, false);
    }
  }

  try {
    await p.choose('6/6 Şimdi Ctrl+C\'ye bas:', [{ label: 'Ctrl+C bekleniyor (Enter\'a basma)', value: 'enter' }]);
    record('Ctrl+C', false, 'Enter basıldı');
  } catch (error) {
    if (!(error instanceof PromptClosedError)) throw error;
    record('Ctrl+C', true, 'yakalandı');
  }
  return summary(results, true);
}

function summary(results, finished) {
  const passed = results.filter((r) => r.ok).length;
  console.log([
    `Sonuç: ${passed}/6${finished ? '' : ' (yarıda kesildi)'}`,
    `HANDOFF satırı: | ${process.env.TERM_PROGRAM ?? (process.env.WT_SESSION ? 'Windows Terminal' : 'konsol')} | ${results.map((r) => `${r.name}: ${r.ok ? 'geçti' : 'KALDI'}`).join(' · ')} |`,
    '',
    'Son elle kontrol: şimdi terminale bir şey yaz. Harfler görünüyor ve imleç',
    'yanıp sönüyorsa raw mode geri alınmış demektir.',
  ].join('\n'));
  return passed === 6 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
