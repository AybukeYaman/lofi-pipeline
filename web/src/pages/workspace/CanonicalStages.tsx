/** Canonical akışta StageSections dışındaki adımlar: 1 (proje), 4 (sıralama). */

import { useEffect, useState } from 'react';

import { fetchProjectMusic, saveTrackOrder } from '../../api';
import { EmptyState } from '../../components/Feedback';
import type { ProjectMusicInfo, TrackOrderMode } from '../../types';
import { ambientFiles, fileName } from './assetState';
import { StagePanel, type StageProps } from './StageSections';
import { errorText } from './StepWidgets';

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

// ---------------------------------------------------------------- 6. Sıralama

export function OrderStage({ project, stageStatus, onProjectUpdate }: StageProps) {
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

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    setOrder(next);
    setMode('manual');
    setSuccess(null);
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
    <StagePanel
      section="order"
      title="4. Sıralama"
      status={savedOrder && savedOrder.length > 0 ? 'ready' : 'waiting'}
      statusLabel={savedOrder && savedOrder.length > 0 ? 'Sıra kaydedildi' : 'Sıra bekleniyor'}
      stageStatus={stageStatus}
    >
      {loadError ? (
        <p className="field-hint field-error" role="alert">
          {loadError}
        </p>
      ) : null}
      <div className="choice-row" role="radiogroup" aria-label="Sıralama yöntemi">
        <label className={mode === 'added' ? 'option selected' : 'option'}>
          <input type="radio" checked={mode === 'added'} onChange={() => setMode('added')} />
          <span>Eklediğim sıra</span>
        </label>
        <label className={mode === 'manual' ? 'option selected' : 'option'}>
          <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} />
          <span>Kendim belirleyeceğim</span>
        </label>
        <label className={mode === 'alphabetical' ? 'option selected' : 'option'}>
          <input type="radio" checked={mode === 'alphabetical'} onChange={() => setMode('alphabetical')} />
          <span>Alfabetik</span>
        </label>
      </div>

      {music && shown.length === 0 ? <EmptyState compact title="Sıralanacak parça yok — önce Müzik adımında yükle." /> : null}
      <ol className="order-list">
        {shown.map((name, index) => (
          <li key={name}>
            <span className="order-number">{index + 1}</span>
            <span className="order-name">{name}</span>
            <span className="muted">{formatDuration(durations.get(name))}</span>
            {mode === 'manual' ? (
              <span className="order-buttons">
                <button className="button" type="button" aria-label={`${name} yukarı`} disabled={index === 0} onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button
                  className="button"
                  type="button"
                  aria-label={`${name} aşağı`}
                  disabled={index === shown.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {error ? (
        <p className="field-hint field-error" role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className="field-hint field-success">✓ {success}</p> : null}
      <div className="stage-footer">
        <button className="button button-primary" type="button" disabled={saving || shown.length === 0} onClick={save}>
          {saving ? 'Kaydediliyor...' : 'Sıralamayı uygula ve kaydet'}
        </button>
      </div>
    </StagePanel>
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
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
