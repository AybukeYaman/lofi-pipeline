/**
 * Dış dünya (sıralı async kod) ile React ekranı arasındaki köprü.
 *
 * Akış kodu `await store.request({ kind, ... })` ile soru sorar; kök bileşen
 * soruyu çizer, tuşları keys.js ile uygular ve `resolveWidget(sonuç)` çağırır.
 * Başlık, günlük, çubuklar ve kısayol satırı da buradan beslenir.
 * React'e useSyncExternalStore ile bağlanır (tek abone beklenir).
 */

import { PromptClosedError } from '../prompt.js';

const LOG_LIMIT = 200;

/**
 * @param {object} [initial] başlangıç alanları (header, footer, ...)
 */
export function createTuiStore(initial = {}) {
  let state = { header: {}, widget: null, log: [], bars: [], footer: '', onKey: null, closed: false, ...initial };
  const listeners = new Set();
  let nextId = 1;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set,

    /**
     * Soru sorar. Aynı anda tek soru (akışlar sıralı).
     * @param {{ kind: 'select'|'multi'|'text', title: string, items?: object[], initial?: string, placeholder?: string }} widget
     * @returns {Promise<unknown>} yanıt ya da keys.BACK
     */
    request(widget) {
      if (state.closed) return Promise.reject(new PromptClosedError());
      if (state.widget) return Promise.reject(new Error('aynı anda tek soru sorulabilir'));
      return new Promise((resolve, reject) => {
        set({ widget: { ...widget, id: nextId++, resolve, reject } });
      });
    },

    resolveWidget(result) {
      const { widget } = state;
      if (!widget) return;
      set({ widget: null });
      widget.resolve(result);
    },

    /** Ctrl+C ya da çıkış: bekleyen soru PromptClosedError ile reddedilir. */
    close() {
      const { widget } = state;
      set({ closed: true, widget: null });
      widget?.reject(new PromptClosedError());
    },

    log(message, level = 'info') {
      set({ log: [...state.log, { message: String(message), level }].slice(-LOG_LIMIT) });
    },
  };
}
