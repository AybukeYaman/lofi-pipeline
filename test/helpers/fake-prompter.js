/**
 * Akış testleri için sahte prompter — tuş ya da satır değil, DEĞER yanıtları.
 *
 * Akışlar (ui/actions.js) prompter'ın nasıl çizildiğini bilmez; testleri de
 * bilmemeli. Yanıt kuyruğu:
 *   'metin'            ask
 *   pick('etiket')     choose — etiket parçası ya da value eşitliği
 *   picks('a', 'b')    chooseMany
 *   true / false       confirm
 *   BACK               Esc / geri
 *   async (soru) => …  yukarıdakilerden birini döndürür; arada dosya kurulabilir
 *
 * Asılı kalmaz: yanıt biterse, türü uymazsa, seçenek bulunamazsa ya da devre
 * dışıysa anlaşılır hatayla düşer. closeWhenEmpty: yanıt bitince
 * PromptClosedError (menüde Ctrl+C taklidi).
 */

import { PromptClosedError } from '../../ui/prompt.js';

export const BACK = Symbol('BACK');
export const pick = (match) => ({ pick: match });
export const picks = (...matches) => ({ picks: matches });

const describe = (answer) => (typeof answer === 'symbol' ? 'BACK' : JSON.stringify(answer));

/**
 * @param {unknown[]} answers
 * @param {{ closeWhenEmpty?: boolean }} [options]
 */
export function createFakePrompter(answers = [], { closeWhenEmpty = false } = {}) {
  const queue = [...answers];
  const questions = [];
  let text = '';
  const write = (s) => { text += s; };

  async function next(kind, question, items) {
    questions.push({ kind, question, items });
    write(`? ${question}\n`);
    for (const item of items ?? []) write(`  - ${item.label}${item.disabled ? ' (seçilemez)' : ''}\n`);

    if (queue.length === 0) {
      if (closeWhenEmpty) throw new PromptClosedError();
      throw new Error(`yanıt kalmadı: ${kind} "${question}"`);
    }
    let answer = queue.shift();
    if (typeof answer === 'function') answer = await answer({ kind, question, items });
    return answer;
  }

  const wrongKind = (kind, question, answer) =>
    new Error(`${kind} "${question}" için uygun olmayan yanıt: ${describe(answer)}`);

  function resolveItem(items, match, question) {
    const found = items.find((it) => it.value === match)
      ?? items.find((it) => it.label === match)
      ?? items.find((it) => typeof match === 'string' && it.label.includes(match));
    if (!found) {
      throw new Error(`pick(${JSON.stringify(match)}) "${question}" seçeneklerinde yok: ${items.map((i) => i.label).join(' | ')}`);
    }
    if (found.disabled) throw new Error(`pick(${JSON.stringify(match)}) devre dışı seçeneği gösteriyor: ${found.label}`);
    return found;
  }

  return {
    questions,
    output: () => text,

    print(value = '') {
      write(`${value}\n`);
    },

    async ask(question) {
      const answer = await next('ask', question);
      if (answer === BACK) return null;
      if (typeof answer !== 'string') throw wrongKind('ask', question, answer);
      return answer.trim();
    },

    async choose(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return null;
      const answer = await next('choose', title, zeroLabel ? [...items, { label: zeroLabel, value: null }] : items);
      if (answer === BACK) return null;
      if (!answer || typeof answer !== 'object' || !('pick' in answer)) throw wrongKind('choose', title, answer);
      if (zeroLabel && answer.pick === zeroLabel) return null;
      return resolveItem(items, answer.pick, title).value;
    },

    async chooseMany(title, items, { zeroLabel } = {}) {
      const allItems = zeroLabel ? [...items, { label: zeroLabel, value: null }] : items;
      const answer = await next('chooseMany', title, allItems);
      if (answer === BACK) return null;
      if (answer && typeof answer === 'object' && 'pick' in answer) {
        if (zeroLabel && answer.pick === zeroLabel) return [];
        return [resolveItem(items, answer.pick, title).value];
      }
      if (!answer || typeof answer !== 'object' || !('picks' in answer)) throw wrongKind('chooseMany', title, answer);
      const chosen = new Set(answer.picks.map((m) => resolveItem(items, m, title)));
      return items.filter((it) => chosen.has(it)).map((it) => it.value);
    },

    async confirm(question) {
      const answer = await next('confirm', question);
      if (answer === BACK) return false;
      if (typeof answer !== 'boolean') throw wrongKind('confirm', question, answer);
      return answer;
    },
  };
}
