/**
 * TUI Adaptörü — createTuiStore ve Ink render() üzerinden prompter benzeri API.
 * 
 * ui/actions.js veya lofi-tui.js ile uyumluluk sağlar:
 * ask(question, options)
 * choose(title, items, options)
 * chooseMany(title, items, options)
 * confirm(question, options)
 * print(text)
 */

import { PromptClosedError } from './prompt.js';

export function createInkPrompter(store) {
  return {
    print(text = '') {
      store.log(text);
    },

    async ask(question, { defaultValue = '' } = {}) {
      const res = await store.request({
        kind: 'text',
        title: question,
        initial: defaultValue,
      });
      if (typeof res === 'symbol') return null; // BACK
      return String(res ?? '').trim();
    },

    async choose(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return null;
      const listItems = items.map((it) => ({
        label: it.label,
        value: it.value,
        disabled: it.disabled,
      }));
      if (zeroLabel) {
        listItems.push({ label: zeroLabel, value: null });
      }

      const res = await store.request({
        kind: 'select',
        title,
        items: listItems,
      });
      if (typeof res === 'symbol') return null; // BACK
      return res;
    },

    async chooseMany(title, items, { zeroLabel } = {}) {
      if (items.length === 0 && !zeroLabel) return [];
      const listItems = items.map((it) => ({
        label: it.label,
        value: it.value,
        disabled: it.disabled,
      }));
      if (zeroLabel) {
        listItems.push({ label: zeroLabel, value: null });
      }

      const res = await store.request({
        kind: 'multi',
        title,
        items: listItems,
      });
      if (typeof res === 'symbol') return null;
      if (Array.isArray(res)) {
        return res.filter((val) => val !== null);
      }
      return [];
    },

    async confirm(question, { defaultValue = false } = {}) {
      const items = [
        { label: 'Evet', value: true },
        { label: 'Hayır', value: false },
      ];
      // Eğer default Hayır ise Hayır seçeneğini üste koy veya imleci yönlendir
      const res = await store.request({
        kind: 'select',
        title: question,
        items: defaultValue ? items : [items[1], items[0]],
      });
      if (typeof res === 'symbol') return false;
      return Boolean(res);
    },
  };
}
