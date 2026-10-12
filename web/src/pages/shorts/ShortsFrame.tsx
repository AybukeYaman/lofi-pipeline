import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import {
  clamp,
  computeShortsCrop,
  MAX_ZOOM,
  MIN_ZOOM,
  type Crop,
  type Frame,
} from '../../shortsFrame';

type ShortsFramePickerProps = {
  videoUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  frame: Frame;
  onChange: (frame: Frame) => void;
  /** Önizlemenin duracağı an (seçimin başı) — `#t=` ile tek kare gösterilir. */
  previewTime: number;
};

/**
 * 9:16 kadraj seçici: kaynak videonun tamamı görünür, üstündeki dikey çerçeve
 * render'da kullanılacak alanı gösterir. Çerçeveyi sürükleyerek kadrajı
 * taşıyor, kaydırıcıyla yakınlaştırıyorsun.
 *
 * Çerçevenin ölçüsü UI'da uydurulmuyor: `computeShortsCrop` sunucudaki
 * formülün aynısı (`web/src/shortsFrame.ts`), bu yüzden burada gördüğün kutu
 * render'da çıkan kutudur.
 */
export function ShortsFramePicker({
  videoUrl,
  sourceWidth,
  sourceHeight,
  frame,
  onChange,
  previewTime,
}: ShortsFramePickerProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ pointerX: 0, pointerY: 0, x: 0.5, y: 0.5 });

  const crop = computeShortsCrop(sourceWidth, sourceHeight, frame);
  const freeX = Math.max(1, sourceWidth - crop.width);
  const freeY = Math.max(1, sourceHeight - crop.height);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    origin.current = { pointerX: event.clientX, pointerY: event.clientY, x: frame.x, y: frame.y };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return undefined;

    const move = (event: PointerEvent) => {
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      // Ekrandaki piksel farkı → kaynak videodaki piksel farkı → oran.
      const dxSource = ((event.clientX - origin.current.pointerX) / rect.width) * sourceWidth;
      const dySource = ((event.clientY - origin.current.pointerY) / rect.height) * sourceHeight;
      onChange({
        zoom: frame.zoom,
        x: clamp(origin.current.x + dxSource / freeX, 0, 1),
        y: clamp(origin.current.y + dySource / freeY, 0, 1),
      });
    };
    const stop = () => setDragging(false);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [dragging, frame.zoom, freeX, freeY, onChange, sourceHeight, sourceWidth]);

  const framedUrl = `${videoUrl}#t=${previewTime.toFixed(2)}`;

  return (
    <div className="shorts-frame-picker">
      <div className="shorts-frame-stage">
        <div
          className="shorts-frame-box"
          ref={boxRef}
          style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
        >
          <video src={framedUrl} preload="metadata" muted playsInline />
          <div
            className={`shorts-frame-rect${dragging ? ' is-dragging' : ''}`}
            style={{
              left: `${(crop.x / sourceWidth) * 100}%`,
              top: `${(crop.y / sourceHeight) * 100}%`,
              width: `${(crop.width / sourceWidth) * 100}%`,
              height: `${(crop.height / sourceHeight) * 100}%`,
            }}
            onPointerDown={beginDrag}
            title="9:16 kadrajı sürükle"
          >
            <span className="shorts-frame-tag">9:16</span>
          </div>
        </div>

        <div className="shorts-frame-controls">
          <label>
            Zoom
            <input
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.05}
              value={frame.zoom}
              onChange={(event) => onChange({ ...frame, zoom: Number(event.target.value) })}
            />
            <span className="muted">{frame.zoom.toFixed(2)}×</span>
          </label>
        </div>
      </div>
    </div>
  );
}

type ShortsPreviewProps = {
  videoUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  crop: Crop;
  /** Durağan önizleme için an; verilmezse videonun başı. */
  time?: number;
  /** Render edilmiş kesit gibi tam oynatılabilir önizleme. */
  controls?: boolean;
  /** Kaynaktan oynatırken aralık dışına çıkmayı engeller. */
  range?: { start: number; end: number } | null;
};

/**
 * 9:16 önizleme: videonun YALNIZCA kırpılan bölgesi görünür.
 *
 * Kutu 9:16, içindeki video kırpma oranında büyütülüp kaydırılıyor
 * (`width = kaynak/kırpma`, negatif `left/top` ofseti) — render'ı beklemeden
 * sonucun nasıl görüneceği belli olur. Render edilmiş kesitlerde crop zaten
 * dosyaya işlendiği için 1:1 gösterilir (`crop` kaynak ölçüsüne eşit).
 */
export function ShortsPreview({
  videoUrl,
  sourceWidth,
  sourceHeight,
  crop,
  time = 0,
  controls = false,
  range = null,
}: ShortsPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Aralık dışına taşan oynatma başa sarılır: kaynaktan önizlerken kesidin
  // bittiği yerde durması gerekiyor (dosya henüz yok, video devam ediyor).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !range) return undefined;
    const onTimeUpdate = () => {
      if (video.currentTime > range.end || video.currentTime < range.start - 0.5) {
        video.currentTime = range.start;
        video.pause();
      }
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => video.removeEventListener('timeupdate', onTimeUpdate);
  }, [range]);

  const src = time > 0 ? `${videoUrl}#t=${time.toFixed(2)}` : videoUrl;

  return (
    <div className="shorts-preview" style={{ aspectRatio: '9 / 16' }}>
      <video
        ref={videoRef}
        src={src}
        preload="metadata"
        muted={!controls}
        playsInline
        controls={controls}
        style={{
          width: `${(sourceWidth / crop.width) * 100}%`,
          height: `${(sourceHeight / crop.height) * 100}%`,
          left: `${(-crop.x / crop.width) * 100}%`,
          top: `${(-crop.y / crop.height) * 100}%`,
        }}
      />
    </div>
  );
}
