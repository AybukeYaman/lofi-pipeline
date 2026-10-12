/**
 * Video üstü yazı editörü — her şey önizlemenin üzerinde, fareyle:
 *
 *   - Yazıyı tut, sürükle (ortaya ve kenar boşluklarına kendiliğinden yapışır).
 *   - Köşesindeki küçük kareden tut: büyüt / küçült.
 *   - Çift tıkla: yazıyı değiştir. Boş yere çift tıkla: oraya yeni yazı ekle.
 *   - Seçince üstünde çıkan çubuktan renk seç ya da sil.
 *   - Kaydet düğmesi yok: yaptığın her şey kendiliğinden kaydedilir.
 *
 * İKİ AYRI İŞ, KARIŞMAZ:
 *   - Burası yalnızca yazının GÖRÜNÜMÜNÜ düzenler (yer, boyut, renk, metin).
 *   - "Çalışma / Mola" yazısı ve "Kalan süre" sayacının NE ZAMAN değiştiği
 *     Pomodoro planından gelir; editör onu yalnızca OKUR ve değiştiremez.
 *
 * Yer formülü sunucuyla aynı (`labelFrame.ts` ↔ `core/label-filter.js`):
 * önizlemede gördüğün yer videoda çıkan yerdir.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
} from 'react';

import { fetchProjectLabels, updateProjectLabels } from '../api';
import {
  aspectRatioOf,
  dragPosition,
  labelTitle,
  labelTopLeft,
  newLabel,
  nudge,
  pointerFraction,
  previewText,
  scaledSize,
  snapPosition,
} from '../labelFrame';
import type { LabelKind, ProjectLabels, VideoLabel } from '../types';

type LabelEditorProps = {
  projectId: string;
  /** Kaydedilince etiket sayısını üst ekrana bildirir (özet satırı için). */
  onSaved?: (labelCount: number) => void;
};

const COLORS: Array<{ text: string; value: string }> = [
  { text: 'Beyaz', value: '#ffffff' },
  { text: 'Siyah', value: '#000000' },
  { text: 'Sarı', value: '#ffd93b' },
  { text: 'Pembe', value: '#ff6fa8' },
  { text: 'Mavi', value: '#5ec8ff' },
  { text: 'Yeşil', value: '#7be495' },
];

/** Değişiklikten sonra kaydetmeden önce beklenen süre (ms). */
const AUTOSAVE_DELAY_MS = 700;
const MAX_HISTORY = 30;

type FrameSize = { width: number; height: number };
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

type ChipProps = {
  label: VideoLabel;
  text: string;
  frame: FrameSize;
  selected: boolean;
  editing: boolean;
  /** Sürüklerken seçim çubuğu gizlenir. */
  busy: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, label: VideoLabel) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, label: VideoLabel, width: number) => void;
  onEdit: (label: VideoLabel) => void;
  onTextChange: (id: string, text: string) => void;
  onEditDone: () => void;
  onColor: (id: string, color: string) => void;
  onRemove: (id: string) => void;
};

/** Önizlemedeki tek yazı: kendi ölçüsünü ölçüp sunucudaki kıstırmayla yerleşir. */
function LabelChip({
  label, text, frame, selected, editing, busy,
  onPointerDown, onResizeStart, onEdit, onTextChange, onEditDone, onColor, onRemove,
}: ChipProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [box, setBox] = useState<FrameSize>({ width: 0, height: 0 });
  const isText = label.kind === 'text';

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => setBox({ width: element.offsetWidth, height: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, label.size, frame.height, editing]);

  // Yeni eklenen yazı ölçülene kadar gizli (zıplamasın); gizli öğe odak alamaz. Bu yüzden
  // odak ve "hepsini seç" ölçüm bittikten SONRA verilir: yazmaya başlayınca eski yazı silinir.
  const measured = box.width > 0;
  useEffect(() => {
    if (editing && measured) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, measured]);

  const { left, top } = labelTopLeft(label, box, frame);
  const toolbarBelow = label.y < 0.2;
  const toolbarRight = label.x > 0.6;

  return (
    <div
      ref={ref}
      className={`label-chip${selected ? ' is-selected' : ''}${editing ? ' is-editing' : ''}`}
      style={{
        left,
        top,
        fontSize: Math.max(1, label.size * frame.height),
        color: label.color,
        // Ölçü yokken (ilk çizim) göstermeyip zıplamayı önle.
        visibility: box.width === 0 ? 'hidden' : 'visible',
      }}
      onPointerDown={(event) => { if (!editing) onPointerDown(event, label); }}
      onDoubleClick={(event) => { event.stopPropagation(); if (isText) onEdit(label); }}
      title={isText ? 'Sürükle · çift tıkla: değiştir' : `${labelTitle(label)} · sürükle`}
    >
      {editing ? (
        <input
          className="label-chip-input"
          ref={inputRef}
          value={label.text}
          maxLength={120}
          size={Math.max(4, label.text.length)}
          aria-label="Yazıyı değiştir"
          onChange={(event) => onTextChange(label.id, event.target.value)}
          onBlur={onEditDone}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur();
          }}
        />
      ) : text}

      {selected && !editing && !busy ? (
        <>
          <div
            className={`label-bar${toolbarBelow ? ' is-below' : ''}${toolbarRight ? ' is-right' : ''}`}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            {COLORS.map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={label.color === choice.value ? 'label-color-dot is-active' : 'label-color-dot'}
                style={{ background: choice.value }}
                aria-label={choice.text}
                title={choice.text}
                onClick={() => onColor(label.id, choice.value)}
              />
            ))}
            {isText ? (
              <button type="button" className="label-bar-button" title="Yazıyı değiştir" aria-label="Yazıyı değiştir" onClick={() => onEdit(label)}>
                ✎
              </button>
            ) : null}
            <button type="button" className="label-bar-button is-danger" title="Sil" aria-label="Yazıyı sil" onClick={() => onRemove(label.id)}>
              ✕
            </button>
          </div>
          <span
            className="label-handle"
            title="Büyüt / küçült"
            onPointerDown={(event) => { event.stopPropagation(); onResizeStart(event, label, box.width); }}
          />
        </>
      ) : null}
    </div>
  );
}

export function LabelEditor({ projectId, onSaved }: LabelEditorProps) {
  const [data, setData] = useState<ProjectLabels | null>(null);
  const [draft, setDraft] = useState<VideoLabel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Önizlemede hangi anın gösterileceği: Pomodoro yazıları için çalışma ya da mola. */
  const [phase, setPhase] = useState<'ready' | 'work' | 'break'>('work');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drag, setDrag] = useState<'move' | 'resize' | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [frame, setFrame] = useState<FrameSize>({ width: 0, height: 0 });
  const [history, setHistory] = useState<VideoLabel[][]>([]);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const origin = useRef({ x: 0, y: 0, pointerX: 0, pointerY: 0, size: 0, width: 0, clientX: 0 });
  const draggedId = useRef<string | null>(null);
  /** Sunucuya en son yazılan (ya da ilk yüklenen) hâl — değişiklik var mı bununla ölçülür. */
  const savedJson = useRef('[]');

  useEffect(() => {
    let active = true;
    fetchProjectLabels(projectId)
      .then((loaded) => {
        if (!active) return;
        setData(loaded);
        setDraft(loaded.labels);
        savedJson.current = JSON.stringify(loaded.labels);
        setSelectedId(loaded.labels[0]?.id ?? null);
      })
      .catch((err) => { if (active) setLoadError(err instanceof Error ? err.message : 'Yazılar yüklenemedi.'); });
    return () => { active = false; };
  }, [projectId]);

  // Kare ölçüsü: yazının kıstırması ve boyutu bu ölçüye göre.
  const hasFrame = data !== null;
  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return undefined;
    const measure = () => setFrame({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasFrame]);

  const update = useCallback((id: string, patch: Partial<VideoLabel>) => {
    setDraft((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  /** Geri almak için önceki hâli sakla (sürükleme gibi sürekli değişimlerde başta bir kez). */
  const remember = useCallback(() => {
    setHistory((current) => [...current.slice(-(MAX_HISTORY - 1)), draft]);
  }, [draft]);

  // --- otomatik kaydetme: değişiklikten kısa süre sonra, sürüklerken değil.
  useEffect(() => {
    if (!data || drag !== null || editingId !== null) return undefined;
    const json = JSON.stringify(draft);
    if (json === savedJson.current) return undefined;
    // Boş yazı sunucuda reddedilir; kullanıcı yazıyı doldurana kadar bekle.
    if (draft.some((item) => item.kind === 'text' && item.text.trim() === '')) return undefined;

    const timer = window.setTimeout(() => {
      setSaveState('saving');
      setSaveError(null);
      updateProjectLabels(projectId, { labels: draft })
        .then((saved) => {
          savedJson.current = json;
          setData(saved);
          setSaveState('saved');
          onSaved?.(saved.labels.length);
        })
        .catch((err) => {
          setSaveState('error');
          setSaveError(err instanceof Error ? err.message : 'Kaydedilemedi.');
        });
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, data, drag, editingId, projectId, onSaved]);

  const selected = draft.find((item) => item.id === selectedId) ?? null;
  const sessions = data?.pomodoro.sessions ?? [];
  const pomodoroOn = data?.pomodoro.enabled === true;

  // Önizleme anı: çalışma → ilk çalışma oturumunun 10. sn'si, mola → ilk molanın 10. sn'si.
  const sessionOfPhase = sessions.find((session) => session.kind === phase) ?? null;
  const previewTime = sessionOfPhase ? sessionOfPhase.startSeconds + 10 : 0;

  // --- sürükleme (taşı / boyutlandır): window dinleyicileri, Shorts ile aynı
  const beginMove = (event: ReactPointerEvent<HTMLElement>, label: VideoLabel) => {
    event.preventDefault();
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pointer = pointerFraction({ x: event.clientX, y: event.clientY }, rect);
    origin.current = { ...origin.current, x: label.x, y: label.y, pointerX: pointer.x, pointerY: pointer.y };
    draggedId.current = label.id;
    remember();
    setSelectedId(label.id);
    setDrag('move');
    frameRef.current?.focus();
  };

  const beginResize = (event: ReactPointerEvent<HTMLElement>, label: VideoLabel, width: number) => {
    event.preventDefault();
    origin.current = { ...origin.current, size: label.size, width, clientX: event.clientX };
    draggedId.current = label.id;
    remember();
    setDrag('resize');
  };

  useEffect(() => {
    if (drag === null) return undefined;
    const move = (event: PointerEvent) => {
      const id = draggedId.current;
      if (!id) return;
      if (drag === 'resize') {
        update(id, { size: scaledSize(origin.current.size, origin.current.width, event.clientX - origin.current.clientX) });
        return;
      }
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pointer = pointerFraction({ x: event.clientX, y: event.clientY }, rect);
      const free = dragPosition(origin.current, pointer);
      // Shift basılıysa yapışma kapalı: tam istediğin yere koy.
      if (event.shiftKey) {
        update(id, free);
        setGuides({ x: null, y: null });
        return;
      }
      const snapped = snapPosition(free);
      update(id, { x: snapped.x, y: snapped.y });
      setGuides({ x: snapped.guideX, y: snapped.guideY });
    };
    const stop = () => { setDrag(null); setGuides({ x: null, y: null }); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [drag, update]);

  // --- ekle / sil / değiştir
  const add = (kind: LabelKind, position?: { x: number; y: number }) => {
    remember();
    const created = { ...newLabel(kind, draft), ...(position ?? {}) };
    setDraft((current) => [...current, created]);
    setSelectedId(created.id);
    if (kind === 'text') setEditingId(created.id);
  };

  const remove = (id: string) => {
    remember();
    setDraft((current) => current.filter((item) => item.id !== id));
    setSelectedId((current) => (current === id ? null : current));
    setEditingId(null);
  };

  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setDraft(previous);
    setEditingId(null);
    setSelectedId((current) => (previous.some((item) => item.id === current) ? current : null));
  };

  const startEdit = (label: VideoLabel) => {
    if (label.kind !== 'text') return;
    remember();
    setSelectedId(label.id);
    setEditingId(label.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!selected || editingId) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove(selected.id);
      return;
    }
    // Yön tuşları: gizli kolaylık (Shift = büyük adım).
    const step = event.shiftKey ? 0.02 : 0.005;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    update(selected.id, nudge(selected, move[0], move[1]));
  };

  const addAtPointer = (event: React.MouseEvent<HTMLDivElement>) => {
    const tag = (event.target as HTMLElement).tagName;
    if (event.target !== event.currentTarget && tag !== 'VIDEO' && tag !== 'IMG') return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    add('text', pointerFraction({ x: event.clientX, y: event.clientY }, rect));
  };

  if (loadError) return <p className="form-error">{loadError}</p>;
  if (!data) return <p className="field-hint">Yükleniyor...</p>;

  const hasKind = (kind: LabelKind) => draft.some((item) => item.kind === kind);
  const preview = data.preview;
  const hasPomodoroLabel = draft.some((item) => item.kind !== 'text');
  const orphanSystem = !pomodoroOn ? draft.filter((item) => item.kind !== 'text') : [];

  return (
    <div className="label-editor">
      {data.problems.map((problem) => (
        <p className="form-error" key={problem}>{problem}</p>
      ))}

      <div className="label-toolbar">
        <button type="button" className="button button-compact" onClick={() => add('text')}>+ Yazı ekle</button>
        {pomodoroOn && !hasKind('pomodoro-status') ? (
          <button type="button" className="button button-compact" onClick={() => add('pomodoro-status')}>
            + Çalışma / Mola yazısı
          </button>
        ) : null}
        {pomodoroOn && !hasKind('pomodoro-countdown') ? (
          <button type="button" className="button button-compact" onClick={() => add('pomodoro-countdown')}>
            + Kalan süre sayacı
          </button>
        ) : null}
        <button type="button" className="button button-compact" onClick={undo} disabled={history.length === 0}>
          ↶ Geri al
        </button>
        <span className={`label-status${saveState === 'error' ? ' is-error' : ''}`} role="status">
          {saveState === 'saving' ? 'Kaydediliyor...'
            : saveState === 'saved' ? '✓ Kaydedildi'
              : saveState === 'error' ? `Kaydedilemedi: ${saveError}`
                : ''}
        </span>
      </div>

      <div className="label-stage">
        <div
          className={`label-frame${drag ? ' is-dragging' : ''}`}
          ref={frameRef}
          // Dikey (9:16) kare sayfayı doldurup dev boyuta çıkmasın: yüksekliği ekranın %60'ıyla sınırla.
          style={{
            aspectRatio: aspectRatioOf(data.aspect),
            width: `min(100%, ${(60 * aspectRatioOf(data.aspect)).toFixed(2)}vh)`,
            marginInline: 'auto',
          }}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            const tag = (event.target as HTMLElement).tagName;
            if (event.target === event.currentTarget || tag === 'VIDEO' || tag === 'IMG') setSelectedId(null);
          }}
          onDoubleClick={addAtPointer}
          aria-label="Video önizlemesi"
        >
          {preview?.kind === 'image' ? <img src={preview.url} alt="" draggable={false} /> : null}
          {preview?.kind === 'video' ? (
            <video src={`${preview.url}#t=10`} muted playsInline preload="metadata" />
          ) : null}
          {!preview ? <span className="label-frame-empty">Önce bir klip ya da görsel seç</span> : null}

          {draft.length === 0 ? (
            <span className="label-frame-hint">Boş yere çift tıkla ya da “+ Yazı ekle”ye bas</span>
          ) : null}

          {guides.x !== null ? <span className="label-guide is-vertical" style={{ left: `${guides.x * 100}%` }} /> : null}
          {guides.y !== null ? <span className="label-guide is-horizontal" style={{ top: `${guides.y * 100}%` }} /> : null}

          {draft.map((item) => {
            const text = previewText(item, sessions, previewTime);
            if (text === null) return null;
            return (
              <LabelChip
                key={item.id}
                label={item}
                text={text}
                frame={frame}
                selected={item.id === selectedId}
                editing={item.id === editingId}
                busy={drag !== null}
                onPointerDown={beginMove}
                onResizeStart={beginResize}
                onEdit={startEdit}
                onTextChange={(id, value) => update(id, { text: value })}
                onEditDone={() => setEditingId(null)}
                onColor={(id, color) => { remember(); update(id, { color }); }}
                onRemove={remove}
              />
            );
          })}
        </div>

        <p className="field-hint">
          Yazıyı tut ve sürükle · köşedeki kareden büyüt/küçült · çift tıkla: değiştir.
          Hizalama için ortaya ve kenarlara kendiliğinden yapışır (Shift basılı tutarsan yapışmaz).
        </p>

        {orphanSystem.length > 0 ? (
          <p className="field-hint">
            Pomodoro kapalı olduğu için çalışma/mola yazısı ve sayaç videoda görünmez.{' '}
            <button
              type="button"
              className="button button-compact"
              onClick={() => orphanSystem.forEach((item) => remove(item.id))}
            >
              Kaldır
            </button>
          </p>
        ) : null}

        {pomodoroOn && hasPomodoroLabel ? (
          <div className="label-time" role="group" aria-label="Önizlemede gösterilen an">
            <span>Önizlemede göster:</span>
            <button
              type="button"
              className={phase === 'ready' ? 'button button-compact button-selected' : 'button button-compact'}
              aria-pressed={phase === 'ready'}
              onClick={() => setPhase('ready')}
            >
              Hazırlık anı
            </button>
            <button
              type="button"
              className={phase === 'work' ? 'button button-compact button-selected' : 'button button-compact'}
              aria-pressed={phase === 'work'}
              onClick={() => setPhase('work')}
            >
              Çalışma anı
            </button>
            <button
              type="button"
              className={phase === 'break' ? 'button button-compact button-selected' : 'button button-compact'}
              aria-pressed={phase === 'break'}
              onClick={() => setPhase('break')}
            >
              Mola anı
            </button>
            <span className="field-hint">Yalnızca önizleme. Çalışma/mola zamanları Pomodoro ayarından gelir.</span>
          </div>
        ) : null}

        {draft.length > 0 ? (
          <p className="field-hint">Yazılı videonun hazırlanması normalden daha uzun sürer.</p>
        ) : null}
      </div>
    </div>
  );
}
