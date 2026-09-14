/**
 * Panelin terminal soruları — soru, numaralı seçim, e/h.
 *
 * Tek sorumluluk: kullanıcıdan satır almak ve biçimlendirilmiş soru basmak.
 * Proje, stil, komut bilmez (onlar ui/actions.js'te).
 *
 * Satırlar kendi kuyruğumuzda tutulur: readline'ın `question`'ı soru
 * sorulmadan önce gelen satırı kaçırıyor (hızlı yazan kullanıcı, testte baştan
 * yazılan yanıtlar). Akışlar test için enjekte edilir.
 */

import { createInterface } from 'node:readline';

export class PromptClosedError extends Error {
  constructor() {
    super('giriş kapandı');
    this.name = 'PromptClosedError';
  }
}

/**
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [streams]
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const lines = [];
  let waiter = null;
  let rl = null;
  let closed = false;
  let suspended = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (waiter) {
      const { reject } = waiter;
      waiter = null;
      reject(new PromptClosedError());
    }
    rl?.close();
  };

  const open = () => {
    rl = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
    rl.on('line', (line) => {
      if (waiter) {
        const { resolve } = waiter;
        waiter = null;
        resolve(line);
      } else {
        lines.push(line);
      }
    });
    // Menüde Ctrl+C: readline dinleyici varsa süreç SIGINT'i üretmez.
    rl.on('SIGINT', finish);
    rl.on('close', () => {
      if (!suspended) finish();
    });
  };

  /** Soruyu basar, sıradaki satırı bekler. Kuyruktaki satırlar kapanıştan önce teslim edilir. */
  const nextLine = (question) => {
    output.write(question);
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (closed) return Promise.reject(new PromptClosedError());
    return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
  };

  const print = (text = '') => output.write(`${text}\n`);

  open();

  return {
    print,

    /**
     * @param {string} question
     * @param {{ defaultValue?: string }} [options] boş girişte döner
     * @returns {Promise<string>}
     */
    async ask(question, { defaultValue } = {}) {
      const hint = defaultValue ? ` [${defaultValue}]` : '';
      const answer = (await nextLine(`${question}${hint}: `)).trim();
      return answer === '' && defaultValue !== undefined ? defaultValue : answer;
    },

    /**
     * Numaralı liste. `disabled` öğeler gösterilir ama seçilemez.
     *
     * @template T
     * @param {string} title
     * @param {{ label: string, value: T, disabled?: boolean }[]} items
     * @param {{ zeroLabel?: string }} [options] verilirse `0)` satırı → null
     * @returns {Promise<T | null>}
     */
    async choose(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return null;
      print(title);
      items.forEach((item, i) => print(`  ${i + 1}) ${item.label}`));
      if (zeroLabel) print(`  0) ${zeroLabel}`);

      const range = `${zeroLabel ? 0 : 1}–${items.length}`;
      for (;;) {
        const answer = (await nextLine('Seçim: ')).trim();
        const n = /^\d+$/.test(answer) ? Number(answer) : NaN;
        if (n === 0 && zeroLabel) return null;
        if (n >= 1 && n <= items.length) {
          if (!items[n - 1].disabled) return items[n - 1].value;
          print(`${n}) seçilemez.`);
          continue;
        }
        print(`${range} arası bir numara gir.`);
      }
    },

    /**
     * @param {string} question
     * @param {{ defaultValue?: boolean }} [options]
     * @returns {Promise<boolean>}
     */
    async confirm(question, { defaultValue = false } = {}) {
      for (;;) {
        const answer = (await nextLine(`${question} ${defaultValue ? '[E/h]' : '[e/H]'} `)).trim();
        if (answer === '') return defaultValue;
        if (/^(e|evet|y|yes)$/i.test(answer)) return true;
        if (/^(h|hayır|hayir|n|no)$/i.test(answer)) return false;
        print('e ya da h gir.');
      }
    },

    /** Alt süreç stdin'i devralırken okuyucuyu bırakır; kuyruk korunur. */
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      rl.close();
      rl = null;
    },

    resume() {
      if (closed || !suspended) return;
      suspended = false;
      open();
    },

    close() {
      suspended = false;
      finish();
    },
  };
}

/**
 * PowerShell'e sürükle-bırakla gelen yol: `"C:\a b.jpg"`, `'C:\a b.jpg'`,
 * `& 'C:\a b.jpg'` → `C:\a b.jpg`.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanPath(text) {
  let path = String(text ?? '').trim().replace(/^&\s*(?=["'])/, '');
  if (path.length >= 2 && (path[0] === '"' || path[0] === "'") && path.at(-1) === path[0]) {
    path = path.slice(1, -1);
  }
  return path.trim();
}
