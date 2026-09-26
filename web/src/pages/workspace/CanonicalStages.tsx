/** Canonical akışta daha önce ekranı olmayan adımlar: 1, 3, 5 ve 8. */

import { useEffect, useState } from 'react';

import {
  fetchProjectMusic,
  getProjectImageUrl,
  saveTrackOrder,
  updateProjectAngles,
  uploadProjectImage,
} from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState } from '../../components/Feedback';
import { IMAGE_ACCEPT } from '../../imageTypes';
import type { ProjectMusicInfo, TrackOrderMode } from '../../types';
import { ambientFiles, fileName, styleName } from './assetState';
import { StagePanel, type StageProps } from './StageSections';
import { CopyPrompt, errorText, UploadButton } from './StepWidgets';

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
          <dt>Görsel Stili (Image Style)</dt>
          <dd>{styleName(project) ?? '—'}</dd>
        </div>
        <div>
          <dt>Ambient ses</dt>
          <dd>{ambients.length > 0 ? ambients.map((path) => fileName(path)).join(', ') : 'Yok'}</dd>
        </div>
        <div>
          <dt>Promptlar</dt>
          <dd>
            <code>{project.promptsPath ?? 'prompts.md'}</code>
          </dd>
        </div>
      </dl>
    </StagePanel>
  );
}

// ---------------------------------------------------------------- 3. Referans görsel

export function ReferenceStage({ project, stageStatus, onProjectUpdate }: StageProps) {
  const sceneUrl = project.sceneRef ? getProjectImageUrl(project.id, 'scene', project.sceneRef) : null;
  const hasScene = Boolean(project.sceneRef);
  const inferred = !hasScene && Boolean(project.master);

  return (
    <StagePanel
      section="reference"
      title="3. Referans görsel"
      status={hasScene || inferred ? 'ready' : 'waiting'}
      statusLabel={hasScene ? 'Referans hazır' : inferred ? 'Master mevcut' : 'Görsel bekleniyor'}
      stageStatus={stageStatus}
    >
      <div className="stage-media">
        <AssetPreview
          kind="image"
          fileName={fileName(project.sceneRef)}
          src={sceneUrl}
          emptyLabel={
            inferred
              ? 'Sahne referansı kaydı yok; master frame zaten üretildiği için bu adım tamam sayılır.'
              : 'Henüz sahne referansı yok.'
          }
        />
        <div className="stage-actions">
          {hasScene ? <p className="field-hint field-success">✓ Referans alındı: {fileName(project.sceneRef)}</p> : null}
          <UploadButton
            label={hasScene ? 'Referansı değiştir' : 'Sahne görselini yükle'}
            accept={IMAGE_ACCEPT}
            onFiles={async ([file]) => {
              onProjectUpdate?.(await uploadProjectImage(project.id, 'scene', file));
            }}
          />
          <p className="field-hint">JPG, PNG, WEBP (en fazla 15 MB). resimler\scene-ref olarak kaydedilir.</p>
        </div>
      </div>
    </StagePanel>
  );
}

// ---------------------------------------------------------------- 5. Kamera açıları

const MAX_ANGLES = 5;

export function AnglesStage({
  project,
  stageStatus,
  onProjectUpdate,
  prompts,
  promptsError,
}: StageProps) {
  const decision = project.projectJson?.data?.workflow?.angles;
  const angleFiles = project.angles ?? [];
  const [count, setCount] = useState<number>(decision?.wanted ? decision.count ?? 1 : 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (decision?.wanted && decision.count) setCount(decision.count);
  }, [decision?.wanted, decision?.count]);

  const choose = async (wanted: boolean, nextCount?: number) => {
    setSaving(true);
    setError(null);
    try {
      onProjectUpdate?.(await updateProjectAngles(project.id, wanted ? { wanted, count: nextCount } : { wanted }));
    } catch (err: unknown) {
      setError(errorText(err, 'Seçim kaydedilemedi.'));
    } finally {
      setSaving(false);
    }
  };

  const fileForIndex = (index: number) =>
    angleFiles.find((path) => new RegExp(`^master${index}\\.`, 'i').test(fileName(path) ?? ''));
  const wanted = decision?.wanted === true;
  const requested = wanted ? decision?.count ?? 1 : 0;
  const uploaded = Array.from({ length: requested }, (_, i) => fileForIndex(i + 1)).filter(Boolean).length;
  const statusLabel = decision?.wanted === false
    ? 'Atlandı'
    : wanted
      ? `${uploaded}/${requested} açı yüklendi`
      : angleFiles.length > 0
        ? `${angleFiles.length} açı mevcut`
        : 'Karar bekleniyor';

  return (
    <StagePanel
      section="angles"
      title="5. Kamera açıları (opsiyonel)"
      status={decision?.wanted === false ? 'optional' : wanted && uploaded >= requested ? 'ready' : 'waiting'}
      statusLabel={statusLabel}
      stageStatus={stageStatus}
    >
      <div className="choice-row">
        <span>Kaç farklı açı?</span>
        <select value={count} disabled={saving} onChange={(event) => setCount(Number(event.target.value))}>
          {Array.from({ length: MAX_ANGLES }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </select>
        <button className="button button-primary" type="button" disabled={saving} onClick={() => choose(true, count)}>
          Evet, {count} açı istiyorum
        </button>
        <button className="button" type="button" disabled={saving} onClick={() => choose(false)}>
          Hayır, atla → Video
        </button>
      </div>
      {error ? (
        <p className="field-hint field-error" role="alert">
          {error}
        </p>
      ) : null}

      {wanted ? (
        <div className="angle-list">
          <p className="field-hint">
            Her promptu yeni bir sohbette kullan; ek olarak yalnızca master frame'i ver. Üretilen görseli ilgili açının altına yükle.
          </p>
          {Array.from({ length: requested }, (_, i) => {
            const index = i + 1;
            const angle = prompts?.angles[i];
            const file = fileForIndex(index);
            return (
              <div className="angle-item" key={index}>
                <h3>
                  Açı {index}
                  {angle ? ` — ${angle.title}` : ''}
                </h3>
                <CopyPrompt label={`Açı ${index} promptu`} prompt={angle?.prompt} error={promptsError} />
                <div className="stage-media">
                  <AssetPreview
                    kind="image"
                    fileName={fileName(file)}
                    src={file ? getProjectImageUrl(project.id, 'angle', file) : null}
                    emptyLabel="Bu açı henüz yüklenmedi."
                  />
                  <UploadButton
                    label={file ? 'Görseli değiştir' : `Açı ${index} görselini yükle`}
                    accept={IMAGE_ACCEPT}
                    onFiles={async ([upload]) => {
                      onProjectUpdate?.(await uploadProjectImage(project.id, 'angle', upload, index));
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </StagePanel>
  );
}

// ---------------------------------------------------------------- 8. Sıralama

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
      title="8. Sıralama"
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
