/**
 * Panelin terminal soruları — enquirer adaptörü (ok tuşlu seçim).
 *
 * Tek sorumluluk: prompter arayüzünü (ask / choose / chooseMany / confirm /
 * print) enquirer'a bağlamak. enquirer yalnızca bu dosyada; ui/actions.js onu
 * bilmez (paket 2023'ten beri durgun — değişirse yalnızca burası değişir).
 *
 * enquirer 2.4.1 gerçekleri (kaynak koddan doğrulandı, HANDOFF bölüm 12):
 *   - TTY olmayan stdin'de keypress.listen yakalanamayan hata fırlatıp süreci
 *     çökertir → çağıran (lofi.js) TTY'yi önceden denetler.
 *   - Esc ve Ctrl+C ikisi de "cancel": run() '' ile reddeder; hangi tuş
 *     olduğu prompt.state.keypress'te. Esc → geri, Ctrl+C → PromptClosedError.
 *   - Select sonucu seçeneğin `name`'i → sıra numarasıyla adlandırıp değere eşlenir.
 *   - Confirm yalnızca y/t/1 ve n/f/0 tanır (Türkçe "e" false olur) → onay
 *     "Evet / Hayır" seçimiyle yapılır.
 *   - Windows'ta multiselect açık/kapalı yalnızca renkle ayrılıyor → [x] / [ ].
 *   - Node 24+ Ctrl+C çökmesi (enquirer #483) → guardStart, aşağıda.
 */

import enquirer from 'enquirer';
import keypress from 'enquirer/lib/keypress.js';

const { Input, MultiSelect, Select } = enquirer;

/**
 * enquirer #483 (açık; düzeltme PR #485 birleştirilmedi, paket 2023'ten beri
 * sürüm çıkarmıyor): Ctrl+C'de enquirer'ın açtığı readline — SIGINT dinleyicisi
 * olmadığı için — kendini kapatır; enquirer'ın temizleyicisi kapalı arayüzde
 * rl.pause() çağırır ve Node 24+ ERR_USE_AFTER_CLOSE fırlatır. Hata iptal
 * zincirinin dışında yükselir: run() sonuçlanmaz, süreç çöker.
 *
 * İkinci kusur: enquirer "önceki raw mode"u readline raw mode'u AÇTIKTAN sonra
 * kaydediyor; çökme yolunda terminal raw modda kalıyor.
 *
 * start() aynı mantıkla yeniden tanımlanır: kapalı readline'dan kaynaklanan
 * ERR_USE_AFTER_CLOSE yutulur (PR #485'in `if (!rl.closed)` korumasının
 * eşdeğeri) ve raw mode, dinleyici açılmadan ÖNCE okunan değere döndürülür.
 */
function guardStart(prompt) {
  prompt.start = function start() {
    if (this.stop || this.options.show === false) return;
    const { stdin } = this;
    const wasRaw = Boolean(stdin.isRaw);
    const off = keypress.listen(this, this.keypress.bind(this));

    this.stop = () => {
      try {
        off();
      } catch (error) {
        if (error?.code !== 'ERR_USE_AFTER_CLOSE') throw error;
      } finally {
        if (stdin.isTTY && Boolean(stdin.isRaw) !== wasRaw) stdin.setRawMode(wasRaw);
      }
    };
    this.once('close', this.stop);
    this.emit('start', this);
  };
}

/** Uzun listeler kaydırılır; terminal yüksekliğini aşıp çizimi bozmasın. */
const LIST_LIMIT = 10;
const ZERO = 'zero';
const BACK = Symbol('geri');

export class PromptClosedError extends Error {
  constructor() {
    super('giriş kapandı');
    this.name = 'PromptClosedError';
  }
}

/**
 * @param {{
 *   stdin?: NodeJS.ReadStream,
 *   stdout?: NodeJS.WritableStream,
 *   show?: boolean,
 *   onPrompt?: (prompt: object) => void,
 * }} [options] show:false + onPrompt yalnızca test için (tuşlar prompt.keypress ile sürülür)
 */
export function createPrompter({ stdin = process.stdin, stdout = process.stdout, show = true, onPrompt } = {}) {
  const base = { stdin, stdout, show };

  const print = (text = '') => stdout.write(`${text}\n`);

  /** Çok satırlı başlık: son satır soru, öncekiler düz metin. */
  const splitTitle = (title) => {
    const lines = String(title).split('\n');
    const message = lines.pop();
    for (const line of lines) print(line);
    return message;
  };

  async function runPrompt(prompt) {
    guardStart(prompt);
    onPrompt?.(prompt);
    try {
      return await prompt.run();
    } catch (reason) {
      if (reason === '' || reason === undefined) {
        if (prompt.state.keypress?.name === 'escape') return BACK;
        throw new PromptClosedError();
      }
      throw reason;
    }
  }

  const toChoices = (items) => items.map((item, i) => ({
    name: String(i),
    message: item.label,
    disabled: item.disabled ? '(seçilemez)' : false,
  }));

  return {
    print,

    /**
     * @param {string} question
     * @param {{ defaultValue?: string }} [options] boş Enter'da döner
     * @returns {Promise<string | null>} Esc → null
     */
    async ask(question, { defaultValue } = {}) {
      const answer = await runPrompt(new Input({ ...base, message: splitTitle(question), initial: defaultValue }));
      return answer === BACK ? null : String(answer ?? '').trim();
    },

    /**
     * @template T
     * @param {string} title
     * @param {{ label: string, value: T, disabled?: boolean }[]} items
     * @param {{ zeroLabel?: string }} [options] listenin sonuna eklenir; seçilirse null
     * @returns {Promise<T | null>} Esc → null
     */
    async choose(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return null;
      const choices = toChoices(items);
      if (zeroLabel) choices.push({ name: ZERO, message: zeroLabel });

      const answer = await runPrompt(new Select({ ...base, message: splitTitle(title), choices, limit: LIST_LIMIT }));
      if (answer === BACK || answer === ZERO) return null;
      return items[Number(answer)].value;
    },

    /**
     * @template T
     * @param {string} title
     * @param {{ label: string, value: T, disabled?: boolean }[]} items
     * @param {{ zeroLabel?: string }} [options] listenin sonuna eklenir; seçilirse null
     * @returns {Promise<T[] | null>} Esc → null
     */
    async chooseMany(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return [];
      const choices = toChoices(items);
      if (zeroLabel) choices.push({ name: ZERO, message: zeroLabel });

      const answer = await runPrompt(new MultiSelect({
        ...base,
        message: splitTitle(title),
        choices,
        limit: LIST_LIMIT,
        hint: '(Boşluk: işaretle · Enter: onayla · Esc: geri)',
        indicator: (state, choice) => (choice.enabled ? '[x]' : '[ ]'),
      }));
      if (answer === BACK) return null;
      if (Array.isArray(answer) && answer.includes(ZERO)) return [];
      return answer.map(Number).sort((a, b) => a - b).map((i) => items[i].value);
    },

    /**
     * @param {string} question
     * @param {{ defaultValue?: boolean }} [options]
     * @returns {Promise<boolean>} Esc → false
     */
    async confirm(question, { defaultValue = false } = {}) {
      const answer = await runPrompt(new Select({
        ...base,
        message: splitTitle(question),
        choices: [{ name: 'yes', message: 'Evet' }, { name: 'no', message: 'Hayır' }],
        initial: defaultValue ? 0 : 1,
      }));
      return answer === 'yes';
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
