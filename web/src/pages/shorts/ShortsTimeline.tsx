import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { formatTimecode } from '../../shortsFrame';
import { buildTicks } from './timelineTicks';
import { useFilmstrip } from './useFilmstrip';

type DragMode = 'start' | 'end' | 'move' | null;

type ShortsTimelineProps = {
  /** Kaynak videonun toplam süresi (saniye). */
  duration: number;
  /** Oynatıcının o anki konumu — timeline'da çizgi olarak görünür. */
  currentTime: number;
  start: number;
  end: number;
  /** En kısa seçim (sunucu sınırı: limits.minSeconds). */
  minSeconds: number;
  onChange: (range: { start: number; end: number }) => void;
  /** Timeline'a tıklanınca oynatıcıyı o ana götür. */
  onSeek: (seconds: number) => void;
  /** Film şeridi için kaynak video adresi — yoksa şerit çizilmez. */
  sourceUrl?: string | null;
};

/** Bir karenin hedef genişliği (px): şeridin kaç kare alacağı buna bölünür. */
const FRAME_WIDTH = 64;
/** Şerit üst sınırı: uzun videoda yüzlerce kare almak tarayıcıyı yorar. */
const MAX_FRAMES = 40;

/**
 * Video barı + aralık seçici (CapCut'taki kesme alanının karşılığı).
 *
 * ```
 * 00:00 ──── 01:00 ──── 02:00 ──── 03:00      ← zaman cetveli
 * [kare][kare][kare][kare][kare][kare]        ← film şeridi
 *        ┃━━━ [████ seçim ████] ━━━┃          ← tutamaklar + playhead
 * ```
 *
 * Kutunun kenarlarından tutup başlangıç/bitişi, ortasından tutup aralığın
 * tamamını kaydırıyorsun. Boş alana tıklamak oynatıcıyı oraya götürür
 * (seçimi bozmadan).
 *
 * Sürükleme `pointer` olaylarıyla: fare, dokunma ve kalem aynı kodla
 * çalışıyor ve `setPointerCapture` sayesinde imleç kutunun dışına çıksa da
 * sürükleme kopmuyor.
 */
export function ShortsTimeline({
  duration,
  currentTime,
  start,
  end,
  minSeconds,
  onChange,
  onSeek,
  sourceUrl = null,
}: ShortsTimelineProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragMode>(null);
  /** Sürükleme başlangıcındaki durum — "move" için fark hesabı. */
  const dragOrigin = useRef({ pointer: 0, start: 0, end: 0 });
  /** Cetvel adımı ve kare sayısı piksel genişliğine bağlı: ölçülüyor. */
  const [trackWidth, setTrackWidth] = useState(0);

  const safeDuration = duration > 0 ? duration : 0;
  const pct = (seconds: number) => (safeDuration > 0 ? (seconds / safeDuration) * 100 : 0);

  // Genişliği ölç ve pencere boyu değişince yeniden ölç: cetvel seyrekleşsin
  // ya da sıklaşsın (sabit adım küçük ekranda etiketleri üst üste bindiriyor).
  useLayoutEffect(() => {
    const node = trackRef.current;
    if (!node) return undefined;
    const measure = () => setTrackWidth(node.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const ticks = buildTicks(safeDuration, trackWidth);
  // Kare sayısı genişlikten: dar ekranda az kare, geniş ekranda çok. Genişlik
  // her ResizeObserver tetiğinde biraz oynadığı için 4'e yuvarlanıyor —
  // yoksa 1 pikselde şerit baştan üretilirdi.
  const frameCount = trackWidth > 0
    ? Math.min(MAX_FRAMES, Math.max(4, Math.round(trackWidth / FRAME_WIDTH / 4) * 4))
    : 0;
  const filmstrip = useFilmstrip(sourceUrl, safeDuration, frameCount);

  /** Fare konumunu saniyeye çevirir. */
  const secondsAt = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || safeDuration === 0) return 0;
      const ratio = (clientX - rect.left) / rect.width;
      return Math.min(safeDuration, Math.max(0, ratio * safeDuration));
    },
    [safeDuration],
  );

  const beginDrag = (mode: Exclude<DragMode, null>) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragOrigin.current = { pointer: secondsAt(event.clientX), start, end };
    setDrag(mode);
  };

  useEffect(() => {
    if (!drag) return undefined;

    const move = (event: PointerEvent) => {
      const at = secondsAt(event.clientX);
      if (drag === 'start') {
        onChange({ start: Math.min(at, end - minSeconds), end });
        return;
      }
      if (drag === 'end') {
        onChange({ start, end: Math.max(at, start + minSeconds) });
        return;
      }
      // move: aralığın uzunluğu korunur, iki uç da aynı miktarda kayar.
      const origin = dragOrigin.current;
      const span = origin.end - origin.start;
      const shift = at - origin.pointer;
      const nextStart = Math.min(Math.max(0, origin.start + shift), safeDuration - span);
      onChange({ start: nextStart, end: nextStart + span });
    };
    const stop = () => setDrag(null);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [drag, end, minSeconds, onChange, safeDuration, secondsAt, start]);

  /**
   * Uçları `delta` saniye oynatır — hem ok tuşları hem ince ayar düğmeleri
   * buradan geçiyor, sınır kuralı tek yerde kalsın.
   */
  const shift = useCallback(
    (mode: 'start' | 'end', delta: number) => {
      if (mode === 'start') {
        onChange({ start: Math.min(Math.max(0, start + delta), end - minSeconds), end });
      } else {
        onChange({ start, end: Math.min(safeDuration, Math.max(end + delta, start + minSeconds)) });
      }
    },
    [end, minSeconds, onChange, safeDuration, start],
  );

  /** Klavyeyle ince ayar: ok tuşları 0.1 sn, Shift ile 1 sn. */
  const nudge = (mode: 'start' | 'end') => (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 0.1;
    const delta = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    shift(mode, delta);
  };

  const selectionDuration = Math.max(0, end - start);

  return (
    <div className="shorts-timeline">
      <div className="shorts-timeline-meta">
        <span>Başlangıç <strong>00:00.0</strong></span>
        <span>Oynatma <strong>{formatTimecode(currentTime)}</strong></span>
        <span>Bitiş <strong>{formatTimecode(safeDuration)}</strong></span>
      </div>

      {/* Zaman cetveli — track ile aynı genişlikte, aynı yüzdelerle hizalı. */}
      <div className="shorts-ruler" aria-hidden="true">
        {ticks.map((tick) => (
          <span
            key={tick.seconds}
            className={`shorts-tick${tick.major ? ' is-major' : ''}`}
            style={{ left: `${tick.percent}%` }}
          >
            {tick.label ? <i>{tick.label}</i> : null}
          </span>
        ))}
      </div>

      <div
        className={`shorts-track${drag ? ' is-dragging' : ''}`}
        ref={trackRef}
        onPointerDown={(event) => {
          // Boş alana tıklamak: oynatıcıyı oraya götür (seçim bozulmaz).
          if (event.target === trackRef.current) onSeek(secondsAt(event.clientX));
        }}
      >
        {/* Film şeridi — tıklamayı yemesin diye pointer-events: none (CSS). */}
        {filmstrip.frames.length > 0 ? (
          <div className="shorts-filmstrip" aria-hidden="true">
            {filmstrip.frames.map((frame) => (
              <img key={frame.seconds} src={frame.url} alt="" draggable={false} />
            ))}
          </div>
        ) : null}

        <div
          className="shorts-selection"
          style={{ left: `${pct(start)}%`, width: `${pct(selectionDuration)}%` }}
          onPointerDown={beginDrag('move')}
          title="Aralığı kaydır"
        >
          <span className="shorts-selection-label">{formatTimecode(selectionDuration)}</span>
        </div>

        <button
          className="shorts-handle shorts-handle-start"
          type="button"
          style={{ left: `${pct(start)}%` }}
          onPointerDown={beginDrag('start')}
          onKeyDown={nudge('start')}
          aria-label={`Başlangıç ${formatTimecode(start)} — ok tuşlarıyla ince ayar`}
          title="Başlangıcı sürükle"
        />
        <button
          className="shorts-handle shorts-handle-end"
          type="button"
          style={{ left: `${pct(end)}%` }}
          onPointerDown={beginDrag('end')}
          onKeyDown={nudge('end')}
          aria-label={`Bitiş ${formatTimecode(end)} — ok tuşlarıyla ince ayar`}
          title="Bitişi sürükle"
        />

        {/* Oynatma konumu — seçili alanın içindeyken belirginleşir. */}
        <div
          className={`shorts-playhead${currentTime >= start && currentTime <= end ? ' in-selection' : ''}`}
          style={{ left: `${pct(currentTime)}%` }}
          aria-hidden="true"
        />
      </div>

      <div className="shorts-timeline-range">
        <span className="shorts-range-pill">{formatTimecode(start)}</span>
        <span className="muted">
          seçili aralık · {formatTimecode(selectionDuration)}
          {sourceUrl && !filmstrip.done && !filmstrip.failed ? ' · şerit hazırlanıyor...' : ''}
        </span>
        <span className="shorts-range-pill">{formatTimecode(end)}</span>
      </div>

      {/* Milisaniye seviyesinde ince ayar — sürüklemenin piksel hassasiyeti
          uzun videoda yetmiyor (1 px = saniyeler). */}
      <div className="shorts-nudge-bar">
        {(['start', 'end'] as const).map((mode) => (
          <div className="shorts-nudge-group" key={mode}>
            <span className="muted">{mode === 'start' ? 'Başlangıç' : 'Bitiş'}</span>
            {[-1, -0.1, -0.01, 0.01, 0.1, 1].map((delta) => (
              <button
                key={delta}
                className="button shorts-nudge"
                type="button"
                onClick={() => shift(mode, delta)}
                title={`${mode === 'start' ? 'Başlangıcı' : 'Bitişi'} ${delta > 0 ? '+' : ''}${delta} sn oynat`}
              >
                {delta > 0 ? `+${delta}` : delta}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
