/**
 * Soru bileşenlerinin tuş mantığı — saf fonksiyonlar, ink'siz test edilir.
 *
 * Girdi tek merkezde (kök bileşenin useInput'u) okunur ve etkin soruya bu
 * fonksiyonlarla uygulanır. Her bileşenin kendi useInput'u olmaz: soru
 * değişirken birden çok useInput'un birlikte mount/unmount olması ink'in
 * Windows'ta çıkışta asılı kalma hatasını tetikliyor (ink #943).
 *
 * Her fonksiyon `(state, ...) → { state, result? }` döndürür; `result`
 * tanımlıysa soru yanıtlanmıştır (BACK = Esc / geri).
 *
 * `key` ink useInput anahtar nesnesi: upArrow, downArrow, pageUp, pageDown,
 * home, end, return, escape, backspace, delete, leftArrow, rightArrow, ctrl, meta, tab.
 */

export const BACK = Symbol('geri');
const DEFAULT_LIMIT = 10;

// ---------------------------------------------------------------- liste (Select / MultiSelect)

/** Yöndeki ilk seçilebilir öğe; yoksa -1. */
function nextEnabled(items, from, step) {
  for (let i = from; i >= 0 && i < items.length; i += step) {
    if (!items[i].disabled) return i;
  }
  return -1;
}

/** İmleci görünür pencerede tutar. */
function scrolled(state, limit, count) {
  const { cursor } = state;
  let { offset } = state;
  if (cursor < offset) offset = cursor;
  if (cursor >= offset + limit) offset = cursor - limit + 1;
  offset = Math.max(0, Math.min(offset, Math.max(0, count - limit)));
  return { ...state, offset };
}

/**
 * @param {{ disabled?: boolean }[]} items
 * @param {{ limit?: number }} [options]
 */
export function initialList(items, { limit = DEFAULT_LIMIT } = {}) {
  return scrolled({ cursor: nextEnabled(items, 0, 1), offset: 0, limit, checked: [] }, limit, items.length);
}

/** ↑↓ PgUp PgDn Home End — devre dışı öğeler atlanır, sarmalama yok. */
function move(state, items, key) {
  const { cursor, limit } = state;
  const last = items.length - 1;
  let target = null;
  if (key.upArrow) target = nextEnabled(items, cursor - 1, -1);
  else if (key.downArrow) target = nextEnabled(items, cursor + 1, 1);
  else if (key.pageUp) target = nextEnabled(items, Math.max(0, cursor - limit), 1);
  else if (key.pageDown) target = nextEnabled(items, Math.min(last, cursor + limit), -1);
  else if (key.home) target = nextEnabled(items, 0, 1);
  else if (key.end) target = nextEnabled(items, last, -1);
  if (target === null) return null;
  return scrolled({ ...state, cursor: target === -1 ? cursor : target }, limit, items.length);
}

/**
 * @param {ReturnType<typeof initialList>} state
 * @param {{ value: unknown, disabled?: boolean }[]} items
 */
export function selectKey(state, items, input, key) {
  if (key.escape) return { state, result: BACK };
  const moved = move(state, items, key);
  if (moved) return { state: moved };
  if (key.return && state.cursor >= 0 && !items[state.cursor].disabled) {
    return { state, result: items[state.cursor].value };
  }
  return { state };
}

/** Boşluk işaretler/kaldırır; Enter işaretlileri liste sırasında döndürür. */
export function multiSelectKey(state, items, input, key) {
  if (key.escape) return { state, result: BACK };
  const moved = move(state, items, key);
  if (moved) return { state: moved };
  if (input === ' ' && state.cursor >= 0 && !items[state.cursor].disabled) {
    const checked = state.checked.includes(state.cursor)
      ? state.checked.filter((i) => i !== state.cursor)
      : [...state.checked, state.cursor].sort((a, b) => a - b);
    return { state: { ...state, checked } };
  }
  if (key.return) return { state, result: state.checked.map((i) => items[i].value) };
  return { state };
}

// ---------------------------------------------------------------- metin (TextInput)

/** @param {string} [initial] */
export function initialText(initial = '') {
  return { value: initial, cursor: initial.length };
}

const insert = (state, text) => ({
  value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
  cursor: state.cursor + text.length,
});

export function textKey(state, input, key) {
  if (key.escape) return { state, result: BACK };
  if (key.return) return { state, result: state.value };
  if (key.backspace) {
    if (state.cursor === 0) return { state };
    return { state: { value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor), cursor: state.cursor - 1 } };
  }
  if (key.delete) {
    return { state: { ...state, value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1) } };
  }
  if (key.leftArrow) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key.rightArrow) return { state: { ...state, cursor: Math.min(state.value.length, state.cursor + 1) } };
  if (key.home) return { state: { ...state, cursor: 0 } };
  if (key.end) return { state: { ...state, cursor: state.value.length } };
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || !input) return { state };
  return { state: insert(state, input) };
}

/** Yapıştırma: satır sonları atılır (yol ve ad tek satır). */
export function textPaste(state, text) {
  return { state: insert(state, text.replace(/\r?\n/g, '')) };
}
