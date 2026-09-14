/**
 * Kök ekran: sabit başlık · orta panel (içerik + soru) · günlük · çubuklar ·
 * sabit kısayol satırı. Klavye ve yapıştırma TEK yerde (burada) okunur,
 * etkin soruya keys.js ile uygulanır (bkz. keys.js başındaki ink #943 notu).
 *
 * Aşama 10a'da tui-check kullanıyor; 10c'de panelin Dashboard'u bunun üzerine kurulacak.
 */

import { Box, Text, useInput, usePaste, useWindowSize } from 'ink';
import { useRef, useState, useSyncExternalStore } from 'react';

import { h } from './h.js';
import { initialList, initialText, multiSelectKey, selectKey, textKey, textPaste } from './keys.js';
import { ListView, ProgressBar, TextInputView } from './widgets.js';

const FOOTERS = {
  select: '↑↓ gez · Enter seç · Esc geri · Ctrl+C çık',
  multi: '↑↓ gez · Boşluk işaretle · Enter onayla · Esc geri · Ctrl+C çık',
  text: 'Yaz · Enter onayla · Esc geri · Ctrl+C çık',
};

/** Bu genişlikten itibaren orta panel ve günlük yan yana. */
export const WIDE_COLUMNS = 100;

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createTuiStore>,
 *   body?: (state: object, size: { columns: number, rows: number, wide: boolean }) => unknown,
 *   border?: 'round' | 'classic',
 * }} props
 */
export function Screen({ store, body, border = 'round' }) {
  const snap = useSyncExternalStore(store.subscribe, store.getState);
  const { columns, rows } = useWindowSize();
  const local = useRef({ id: null, state: null });
  const [, rerender] = useState(0);

  /** Etkin soru ve yerel durumu; soru değiştiyse durum sıfırlanır. Ref: hızlı tuşlarda kayıp olmasın. */
  const active = () => {
    const widget = store.getState().widget;
    if (!widget) return null;
    if (local.current.id !== widget.id) {
      local.current = {
        id: widget.id,
        state: widget.kind === 'text' ? initialText(widget.initial) : initialList(widget.items, { limit: widget.limit }),
      };
    }
    return { widget, state: local.current.state };
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      store.close();
      return;
    }
    const current = active();
    const { onKey } = store.getState();
    if (onKey?.(input, key, current?.widget ?? null)) return;
    if (!current) return;

    const { widget, state } = current;
    const out = widget.kind === 'text' ? textKey(state, input, key)
      : widget.kind === 'multi' ? multiSelectKey(state, widget.items, input, key)
        : selectKey(state, widget.items, input, key);
    local.current.state = out.state;
    if (out.result !== undefined) store.resolveWidget(out.result);
    else rerender((n) => n + 1);
  });

  usePaste((text) => {
    const current = active();
    if (current?.widget.kind !== 'text') return;
    local.current.state = textPaste(current.state, text).state;
    rerender((n) => n + 1);
  }, { isActive: snap.widget?.kind === 'text' });

  const current = snap.widget ? active() : null;
  const safeColumns = columns || 80;
  const height = Math.max(12, (rows || 30) - 1); // tam yükseklik Windows Terminal'de titretiyor (ink #450)
  const wide = safeColumns >= WIDE_COLUMNS;
  const frame = border === 'classic' ? 'classic' : 'round';
  const logLines = snap.log.slice(-Math.max(3, height - 14));

  const header = h(Box, { borderStyle: frame, borderColor: 'cyan', paddingX: 1, justifyContent: 'space-between' },
    h(Text, null, h(Text, { color: 'magenta', bold: true }, 'lofi'), snap.header.title ? `  ${snap.header.title}` : ''),
    h(Text, { color: snap.header.stepColor ?? 'yellow' }, snap.header.step ?? ''),
  );

  const question = current
    ? h(Box, { flexDirection: 'column', marginTop: 1 },
      h(Text, { bold: true }, current.widget.title),
      current.widget.kind === 'text'
        ? h(TextInputView, { state: current.state, placeholder: current.widget.placeholder })
        : h(ListView, { items: current.widget.items, state: current.state, multi: current.widget.kind === 'multi' }))
    : null;

  const main = h(Box, { borderStyle: frame, flexDirection: 'column', paddingX: 1, flexGrow: 1, overflow: 'hidden' },
    body ? body(snap, { columns: safeColumns, rows: height, wide }) : null,
    question,
  );

  const side = h(Box, {
    borderStyle: frame, flexDirection: 'column', paddingX: 1, overflow: 'hidden',
    ...(wide ? { width: Math.floor(safeColumns * 0.4) } : { height: Math.min(8, logLines.length + 3) }),
  },
  h(Text, { bold: true }, 'Günlük'),
  ...logLines.map((line, i) => h(Text, {
    key: i,
    wrap: 'truncate',
    color: line.level === 'warn' ? 'yellow' : line.level === 'error' ? 'red' : undefined,
  }, line.message)),
  );

  const barWidth = Math.max(10, Math.min(40, safeColumns - 34));
  const bars = snap.bars.length > 0
    ? h(Box, { borderStyle: frame, flexDirection: 'column', paddingX: 1 },
      ...snap.bars.map((bar, i) => h(ProgressBar, { key: i, ...bar, width: barWidth, classic: border === 'classic' })))
    : null;

  const footer = h(Box, { paddingX: 1 },
    h(Text, { dimColor: true }, snap.footer || (current ? FOOTERS[current.widget.kind] : 'Ctrl+C çık')));

  return h(Box, { flexDirection: 'column', width: safeColumns, height },
    header,
    h(Box, { flexDirection: wide ? 'row' : 'column', flexGrow: 1 }, main, side),
    bars,
    footer,
  );
}
