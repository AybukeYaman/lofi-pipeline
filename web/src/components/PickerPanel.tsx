/**
 * Adım panellerine takılan seçicilerin ortak kabuğu (Ambiance, Pomodoro,
 * Promptlar).
 *
 * Üç seçici de aynı kutuyu satır içi stillerle ayrı ayrı yazıyordu — aynı
 * çerçeve, aynı başlık düğmesi, aynı "(n seçili)" rozeti. Kabuk buraya,
 * stiller `styles.css`e alındı (`.picker-*`), böylece tema değişkenleri
 * geçerli oluyor ve üçü bir daha birbirinden kaymıyor.
 *
 * Açılan kısım artık gerçek bir **dropdown**: içerik sayfayı aşağı itmek
 * yerine üstüne biniyor. Uzun formun ortasında seçici açıldığında adımlar
 * yerinden kaymıyor; dışına tıklamak ya da Esc kapatıyor.
 *
 * `open` dışarıdan yönetiliyor: her seçici açılma anına kendi işini bağlıyor
 * (Promptlar listeyi ilk açılışta çekiyor, Ambiance kapanırken çalan sesi
 * susturuyor), o yüzden durum burada tutulmuyor.
 */

import { useEffect, useRef, type ReactNode } from 'react';

type PickerPanelProps = {
  /** Başlık düğmesinin yazısı. */
  label: string;
  /** Başlığın yanındaki küçük sayaç, ör. "(3 seçili)". */
  badge?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Başlık şeridinin sağındaki düğmeler, ör. "Ambiance klasörü". */
  actions?: ReactNode;
  children: ReactNode;
};

export function PickerPanel({ label, badge, open, onOpenChange, actions, children }: PickerPanelProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Dışına tıklamak ve Esc kapatır. Dinleyiciler yalnızca açıkken bağlanır.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        onOpenChange(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  return (
    <div className={open ? 'picker is-open' : 'picker'} ref={rootRef}>
      <div className="picker-head">
        <button
          type="button"
          className="button picker-toggle"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          <span className="picker-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span>{label}</span>
          {badge ? <span className="count">{badge}</span> : null}
        </button>
        {actions}
      </div>

      {open ? <div className="picker-dropdown">{children}</div> : null}
    </div>
  );
}
