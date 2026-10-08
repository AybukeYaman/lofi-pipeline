import { useEffect, useState } from 'react';

export type LayoutCols = 1 | 3;

type LayoutSwitcherProps = {
  value: number;
  onChange: (cols: LayoutCols) => void;
  ariaLabel?: string;
};

/**
 * Kalıcılık burada DEĞİL: değeri `useCardLayout` tutuyor ve localStorage'a
 * kendi yazıyor. Düğme eskiden ayrıca kendi `storageKey`'ine yazıyordu —
 * aynı anahtara iki yerden yazılan çift kayıttı.
 */
export function LayoutSwitcher({
  value,
  onChange,
  ariaLabel = 'Görünüm düzeni: 1x liste veya 3x grid',
}: LayoutSwitcherProps) {
  const currentCols: LayoutCols = value === 1 ? 1 : 3;
  const is3x = currentCols === 3;

  const handleToggle = () => {
    onChange(is3x ? 1 : 3);
  };

  return (
    <button
      type="button"
      className="layout-toggle-switch"
      role="switch"
      aria-checked={is3x}
      aria-label={ariaLabel}
      title={`Şu anki görünüm: ${currentCols}x. Tıklayarak ${is3x ? '1x (Liste)' : '3x (Grid)'} görünümüne geçin.`}
      onClick={handleToggle}
    >
      <span className={`layout-toggle-option ${!is3x ? 'active' : ''}`}>1x</span>
      <span className={`layout-toggle-option ${is3x ? 'active' : ''}`}>3x</span>
      <span className={`layout-toggle-thumb ${is3x ? 'is-3x' : 'is-1x'}`} aria-hidden="true" />
    </button>
  );
}

export function useCardLayout(storageKey: string, defaultCols: LayoutCols = 1): [LayoutCols, (cols: LayoutCols) => void] {
  const [cols, setCols] = useState<LayoutCols>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (parsed === 1 || parsed === 3) {
          return parsed as LayoutCols;
        }
      }
    } catch {
      // ignore
    }
    return defaultCols;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(cols));
    } catch {
      // ignore
    }
  }, [cols, storageKey]);

  return [cols, setCols];
}
