/** Canonical akışta kendi dosyası olmayan adımlar: 1 (proje), 4 (sıralama). */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { fetchProjectMusic, saveTrackOrder } from '../../api';
import { EmptyState } from '../../components/Feedback';
import type { ProjectMusicInfo, TrackOrderMode } from '../../types';
import { ambientFiles, fileName } from './assetState';
import { StagePanel, type StageProps } from './StagePanel';
import { errorText } from '../../format';

// ---------------------------------------------------------------- 1. Proje başlat

export function ProjectStartStage({ project, stageStatus }: StageProps) {
  const ambients = ambientFiles(project);
  return (
    <StagePanel section="project" title="1. Proje başlat" status="ready" statusLabel="Hazır" stageStatus={stageStatus}>
      <dl className="readiness-list">
        <div>
          <dt>Proje adı</dt>
          <dd>{project.name}</dd>
        </div>
        <div>
          <dt>Ambient ses</dt>
          <dd>{ambients.length > 0 ? ambients.map((path) => fileName(path)).join(', ') : 'Yok'}</dd>
        </div>
      </dl>
    </StagePanel>
  );
}

// ---------------------------------------------------------------- 3. Müzik ve sıralama — sıralama bölümü

/** `primary`: kaydet düğmesi o an ekrandaki tek vurgulu eylem mi (çerçeve `MusicOrderStage`de). */
export function OrderSection({ project, primary, onProjectUpdate }: StageProps & { primary: boolean }) {
  const [music, setMusic] = useState<ProjectMusicInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [order, setOrder] = useState<string[]>([]);
  const [mode, setMode] = useState<TrackOrderMode>(project.projectJson?.data?.workflow?.order ?? 'alphabetical');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const savedOrder = project.projectJson?.data?.order;

  useEffect(() => {
    let active = true;
    fetchProjectMusic(project.id)
      .then((info) => {
        if (!active) return;
        setMusic(info);
        // Elle sıralama eklenme sırasından başlar; kayıtlı sıra varsa o, yeni dosyalar sona.
        const files = info.addedOrder ?? info.audioFiles.map((audio) => audio.file);
        const saved = (savedOrder ?? []).filter((name) => files.includes(name));
        setOrder([...saved, ...files.filter((name) => !saved.includes(name))]);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (active) setLoadError(errorText(err, 'Parça listesi yüklenemedi.'));
      });
    return () => {
      active = false;
    };
  }, [project.id, project.audioCount, savedOrder]);

  /** Sürüklenen satırın kaynağı; bırakılınca hedefe TAŞINIR (takas değil). */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);

  const moveTo = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    setMode('manual');
    setSuccess(null);
  };

  /**
   * Sürükleme HTML5 drag API'si ile DEĞİL pointer olaylarıyla: drag API
   * dokunmatikte çalışmıyor ve sentetik olaylarla test edilemiyor.
   * Hedef satır, imlecin Y'si satır kutularıyla karşılaştırılarak bulunur.
   */
  const indexAtY = (clientY: number) => {
    const rows = listRef.current?.children;
    if (!rows) return null;
    for (let i = 0; i < rows.length; i++) {
      const box = rows[i].getBoundingClientRect();
      if (clientY < box.bottom) return i;
    }
    return rows.length - 1;
  };

  // Liste dışında bırakılırsa sürükleme takılı kalmasın.
  useEffect(() => {
    if (dragIndex === null) return;
    const cancel = () => {
      setDragIndex(null);
      setOverIndex(null);
    };
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [dragIndex]);

  const startDrag = (index: number) => (event: ReactPointerEvent<HTMLLIElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // Durum ÖNCE atanır: pointer yakalama bazı durumlarda hata fırlatıyor
    // (etkin olmayan pointer id) ve sürükleme hiç başlamıyordu.
    setDragIndex(index);
    setOverIndex(index);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // yakalama olmadan da pointermove/up satırlara ulaşıyor
    }
  };

  const dragOver = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (dragIndex === null) return;
    const target = indexAtY(event.clientY);
    if (target !== null) setOverIndex(target);
  };

  /**
   * Hedef bırakma anında da yeniden hesaplanır: hızlı sürüklemede arada hiç
   * `pointermove` gelmeyebiliyor, o zaman `overIndex` başlangıçta takılı kalır.
   */
  const endDrag = (event?: ReactPointerEvent<HTMLLIElement>) => {
    if (dragIndex !== null) {
      const target = (event ? indexAtY(event.clientY) : null) ?? overIndex;
      if (target !== null) moveTo(dragIndex, target);
    }
    setDragIndex(null);
    setOverIndex(null);
  };

  const alphabetical = music ? music.audioFiles.map((audio) => audio.file) : [];
  const added = music?.addedOrder ?? alphabetical;
  const shown = mode === 'alphabetical' ? alphabetical : mode === 'added' ? added : order;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await saveTrackOrder(
        project.id,
        mode === 'manual' ? { mode, order } : { mode },
      );
      onProjectUpdate?.(updated);
      setSuccess(ORDER_SAVED_MESSAGES[mode]);
    } catch (err: unknown) {
      setError(errorText(err, 'Sıralama kaydedilemedi.'));
    } finally {
      setSaving(false);
    }
  };

  const durations = new Map(music?.audioFiles.map((audio) => [audio.file, audio.duration]) ?? []);

  return (
    <>
      {loadError ? (
        <p className="field-hint field-error" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="segmented" role="radiogroup" aria-label="Sıralama yöntemi">
        <label className={mode === 'added' ? 'segment selected' : 'segment'}>
          <input type="radio" checked={mode === 'added'} onChange={() => setMode('added')} />
          <span>Eklediğim sıra</span>
        </label>
        <label className={mode === 'manual' ? 'segment selected' : 'segment'}>
          <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} />
          <span>Kendim belirleyeceğim</span>
        </label>
        <label className={mode === 'alphabetical' ? 'segment selected' : 'segment'}>
          <input type="radio" checked={mode === 'alphabetical'} onChange={() => setMode('alphabetical')} />
          <span>Alfabetik</span>
        </label>
      </div>

      {!music && !loadError ? (
        <p className="field-hint" role="status">
          Parçalar okunuyor… Dosya sayısı çoksa süreler hesaplanırken birkaç saniye sürebilir.
        </p>
      ) : null}
      {music && shown.length === 0 ? <EmptyState compact title="Sıralanacak parça yok — önce yukarıdan müzik yükle." /> : null}
      {music && shown.length > 0 ? (
        <p className="field-hint">
          {shown.length} parça · toplam {formatDuration(shown.reduce((sum, name) => sum + (durations.get(name) ?? 0), 0))}
        </p>
      ) : null}
      {mode === 'manual' && shown.length > 1 ? (
        <p className="field-hint">Satırları tutup sürükle · klavyeyle Alt + ↑/↓</p>
      ) : null}
      <ol ref={listRef} className={mode === 'manual' ? 'order-list is-sortable' : 'order-list'}>
        {shown.map((name, index) => {
          const isManual = mode === 'manual';
          return (
            <li
              key={name}
              className={
                [
                  dragIndex === index ? 'is-dragging' : '',
                  overIndex === index && dragIndex !== index ? 'is-over' : '',
                ].filter(Boolean).join(' ') || undefined
              }
              tabIndex={isManual ? 0 : undefined}
              aria-label={isManual ? `${index + 1}. ${name} — sürükleyerek veya Alt + yön tuşlarıyla taşı` : undefined}
              onPointerDown={isManual ? startDrag(index) : undefined}
              onPointerMove={isManual ? dragOver : undefined}
              onPointerUp={isManual ? endDrag : undefined}
              onPointerCancel={isManual ? endDrag : undefined}
              onKeyDown={isManual ? (event) => {
                // Sürükle-bırak klavyeyle çalışmıyor; taşıma Alt + yön ile.
                if (!event.altKey) return;
                const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                if (delta === 0) return;
                event.preventDefault();
                moveTo(index, index + delta);
                // Taşınan satır odakta kalsın ki art arda basılabilsin.
                const list = event.currentTarget.parentElement;
                const next = list?.children[index + delta];
                if (next instanceof HTMLElement) next.focus();
              } : undefined}
            >
              {isManual ? <span className="order-grip" aria-hidden="true">⠿</span> : null}
              <span className="order-number">{index + 1}</span>
              <span className="order-name">{name}</span>
              <span className="muted">{formatDuration(durations.get(name))}</span>
            </li>
          );
        })}
      </ol>

      {error ? (
        <p className="field-hint field-error" role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className="field-hint field-success">✓ {success}</p> : null}
      <div className="stage-footer">
        <button
          className={primary ? 'button button-primary' : 'button'}
          type="button"
          disabled={saving || shown.length === 0}
          onClick={save}
        >
          {saving ? 'Kaydediliyor...' : 'Sıralamayı uygula ve kaydet'}
        </button>
      </div>
    </>
  );
}

const ORDER_SAVED_MESSAGES: Record<TrackOrderMode, string> = {
  alphabetical: 'Alfabetik sıra kaydedildi.',
  added: 'Eklediğin sıra kaydedildi.',
  manual: 'Senin belirlediğin sıra kaydedildi.',
};

function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '';
  const total = Math.round(seconds);
  const ss = String(total % 60).padStart(2, '0');
  if (total >= 3600) return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${ss}`;
  return `${Math.floor(total / 60)}:${ss}`;
}
