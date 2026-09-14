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
 */

import enquirer from 'enquirer';

const { Input, MultiSelect, Select } = enquirer;

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
     * @returns {Promise<T[] | null>} liste sırasında; Esc → null
     */
    async chooseMany(title, items) {
      if (items.length === 0) return [];
      const answer = await runPrompt(new MultiSelect({
        ...base,
        message: splitTitle(title),
        choices: toChoices(items),
        limit: LIST_LIMIT,
        hint: '(Boşluk: işaretle · Enter: onayla · Esc: geri)',
        indicator: (state, choice) => (choice.enabled ? '[x]' : '[ ]'),
      }));
      if (answer === BACK) return null;
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
