/**
 * Görünüm bileşenleri — yalnızca çizer, tuş okumaz (bkz. keys.js).
 *
 * Simgeler ASCII (`>`, `[x]`, `#`/`-` yedeği): Windows konsol fontlarında
 * her Unicode glif bulunmayabiliyor. Çerçeve ve çubuk karakteri `classic`
 * ile ASCII'ye döner (tui-check sonucuna göre).
 */

import { Box, Text } from 'ink';

import { h } from './h.js';

/**
 * @param {{ items: { label: string, disabled?: boolean, hint?: string }[], state: object, multi?: boolean }} props
 */
export function ListView({ items, state, multi = false }) {
  const { cursor, offset, limit, checked } = state;
  const visible = items.slice(offset, offset + limit);

  return h(Box, { flexDirection: 'column' },
    offset > 0 ? h(Text, { dimColor: true }, `  ... yukarıda ${offset} öğe`) : null,
    ...visible.map((item, i) => {
      const index = offset + i;
      const focused = index === cursor;
      const box = multi ? (checked.includes(index) ? '[x] ' : '[ ] ') : '';
      const hint = item.disabled ? ` ${item.hint ?? '(seçilemez)'}` : '';
      return h(Text, {
        key: index,
        color: item.disabled ? 'gray' : (focused ? 'cyan' : undefined),
        bold: focused && !item.disabled,
      }, `${focused ? '> ' : '  '}${box}${item.label}${hint}`);
    }),
    offset + limit < items.length
      ? h(Text, { dimColor: true }, `  ... aşağıda ${items.length - offset - limit} öğe`)
      : null,
  );
}

/** İmleç ters renkli karakterle gösterilir. */
export function TextInputView({ state, placeholder = '' }) {
  const { value, cursor } = state;
  if (value === '' && placeholder) {
    return h(Text, null, h(Text, { inverse: true }, ' '), h(Text, { dimColor: true }, placeholder));
  }
  return h(Text, null,
    value.slice(0, cursor),
    h(Text, { inverse: true }, value[cursor] ?? ' '),
    value.slice(cursor + 1),
  );
}

/**
 * @param {{ ratio: number, width: number, color?: string, label?: string, suffix?: string, classic?: boolean }} props
 *   ratio 0..1 (aralık dışı kırpılır); width çubuk hücre sayısı
 */
export function ProgressBar({ ratio, width, color = 'green', label = '', suffix, classic = false }) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(clamped * width);
  const [full, empty] = classic ? ['#', '-'] : ['█', '░'];
  return h(Text, null,
    label,
    h(Text, { color }, full.repeat(filled)),
    h(Text, { dimColor: true }, empty.repeat(width - filled)),
    ` ${String(Math.round(clamped * 100)).padStart(3)}%`,
    suffix ? ` ${suffix}` : '',
  );
}
