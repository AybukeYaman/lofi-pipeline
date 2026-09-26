import { useEffect, useState, type ReactNode } from 'react';

import {
  assignAlbumToProject,
  completeProjectMusic,
  fetchBuildStatus,
  fetchMusicLibrary,
  fetchProject,
  fetchProjectMaster,
  getProjectClipUrl,
  getProjectMasterUrl,
  getProjectOutputUrl,
  ingestSunoToProject,
  openProjectFolder,
  selectProjectClip,
  startBuild,
  updateProjectCrop,
  uploadProjectAudio,
  uploadProjectClip,
  uploadProjectImage,
  fetchProjectMusic,
  ApiError,
} from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState } from '../../components/Feedback';
import { StatusBadge, type AssetStatus } from '../../components/StatusBadge';
import { TrackList } from '../../components/TrackList';
import { IMAGE_ACCEPT, IMAGE_FORMATS_LABEL } from '../../imageTypes';
import type { BuildJob, MasterFrameInfo, ProjectDetail, ProjectMusicInfo, ProjectPrompts, WorkflowStepId } from '../../types';
import { fileName, musicTracks, type ProjectAssets } from './assetState';
import { CopyPrompt, UploadButton } from './StepWidgets';

/** Adımın canonical akıştaki durumu (backend workflow.steps[].status). */
export type StageStatus = 'done' | 'current' | 'pending';

export type StageProps = {
  project: ProjectDetail;
  assets: ProjectAssets;
  stageStatus: StageStatus;
  onProjectUpdate?: (updatedProject: ProjectDetail) => void;
  onGoToStep?: (step: WorkflowStepId) => void;
  prompts?: ProjectPrompts | null;
  promptsError?: string | null;
};

function sectionAnchor(section: string) {
  return `stage-${section}`;
}

type StagePanelProps = {
  section: string;
  title: string;
  status?: AssetStatus;
  statusLabel?: string;
  stageStatus: StageStatus;
  children: ReactNode;
};

export function StagePanel({ section, title, status, statusLabel, stageStatus, children }: StagePanelProps) {
  return (
    <section
      className={`panel stage-panel${stageStatus === 'current' ? ' is-current' : ''}`}
      id={sectionAnchor(section)}
      aria-labelledby={`${sectionAnchor(section)}-title`}
    >
      <header className="stage-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 id={`${sectionAnchor(section)}-title`}>{title}</h2>
          {stageStatus === 'current' ? (
            <span
              className="stage-current-chip"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: 6,
                background: 'var(--primary-subtle)',
                color: 'var(--primary)',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                border: '1px solid var(--border-current)',
              }}
            >
              Sıradaki adım
            </span>
          ) : null}
        </div>
        <div className="stage-meta">
          {status ? <StatusBadge status={status} label={statusLabel} /> : null}
        </div>
      </header>
      {children}
    </section>
  );
}

export function MasterStage({ project, stageStatus, onProjectUpdate }: StageProps) {
  const masterName = fileName(project.master);
  const masterUrl = masterName ? getProjectMasterUrl(project.id, masterName) : null;
  const isMasterReady = project.readiness?.master?.ready ?? Boolean(project.master);
  const masterBadgeStatus: AssetStatus = isMasterReady ? 'ready' : 'waiting';
  const masterBadgeLabel = isMasterReady ? 'Hazır' : 'Master bekleniyor';

  const [masterInfo, setMasterInfo] = useState<MasterFrameInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    fetchProjectMaster(project.id)
      .then((info) => {
        if (!isActive) return;
        setMasterInfo(info);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      isActive = false;
    };
  }, [project.id, project.master]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setError(null);
    setSuccess(null);

    try {
      const [updated, info] = await Promise.all([
        fetchProject(project.id),
        fetchProjectMaster(project.id).catch(() => null),
      ]);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      if (info) {
        setMasterInfo(info);
      }
      setSuccess(
        updated.master || updated.readiness?.master?.ready
          ? 'Master image detected and loaded.'
          : 'Project refreshed. Save image as resimler\\MASTER.png when ready.',
      );
    } catch {
      setError('Could not refresh project state.');
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder(project.id, 'resimler');
      setSuccess('Opened resimler/ folder in Explorer.');
    } catch {
      setError('Could not open folder in Explorer.');
    }
  };

  return (
    <StagePanel
      section="master"
      title="2. Master görseli"
      status={masterBadgeStatus}
      statusLabel={masterBadgeLabel}
      stageStatus={stageStatus}
    >
      <div className="stage-media">
        <AssetPreview
          kind="image"
          fileName={masterName}
          src={masterUrl}
          emptyLabel="No master image yet. Upload the image you made, or save it as resimler\MASTER.png."
        />
        <div className="stage-actions">
          <UploadButton
            label={isMasterReady ? 'Master görselini değiştir' : 'Master görselini yükle'}
            accept={IMAGE_ACCEPT}
            onFiles={async ([file]) => {
              onProjectUpdate?.(await uploadProjectImage(project.id, 'master', file));
            }}
          />
          {isMasterReady ? <p className="field-hint field-success">✓ Master görseli hazır: {masterName}</p> : null}

          <div
            style={{
              marginTop: 10,
              width: '100%',
              padding: '10px 14px',
              borderRadius: 8,
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
              boxSizing: 'border-box',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                <strong style={{ color: 'var(--text-main)', flexShrink: 0 }}>Target location:</strong>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: 12, minHeight: 26, padding: '2px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  onClick={handleOpenFolder}
                >
                  📂 Open Folder
                </button>
              </div>
              <code
                onClick={handleOpenFolder}
                title="Click to open resimler\ folder in Windows Explorer"
                style={{
                  cursor: 'pointer',
                  wordBreak: 'break-all',
                  background: 'var(--bg-surface)',
                  padding: '6px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--primary)',
                  fontSize: 12,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                }}
              >
                {masterInfo?.folder ?? `${project.dir || project.name}\\resimler`}\MASTER.png
              </code>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 12 }}>
                <span>Supported formats:</span>
                <span style={{ fontWeight: 600, color: 'var(--text-main)' }}>{IMAGE_FORMATS_LABEL}</span>
              </div>
            </div>
          </div>

          {error ? (
            <p className="field-hint field-error" role="alert">
              {error}
            </p>
          ) : null}

          {success ? (
            <p className="field-hint" style={{ color: '#34603f' }}>
              ✓ {success}
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              className="button button-primary"
              type="button"
              disabled={isRefreshing}
              onClick={handleRefresh}
            >
              {isRefreshing ? 'Checking resimler\\...' : 'Check & Refresh Master Image'}
            </button>
          </div>
        </div>
      </div>
    </StagePanel>
  );
}

export function VideoStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  // Tek resim modu: clips = MASTER + açı görselleri (sunucu sıralar, MASTER ilk).
  const isStill = project.videoSource === 'image';
  const clips = project.clips ?? [];
  const currentClip = project.clip?.exists ? project.clip.path : null;
  // Tek klip varsa ve seçim yoksa onu öner; birden fazlaysa kullanıcı seçer.
  // Tek resimde varsayılan her zaman MASTER.
  const suggestedClip = currentClip ?? (isStill || clips.length === 1 ? clips[0] ?? null : null);
  const mediaFolder = isStill ? 'resimler' : 'videolar';
  // build.js kırpma kaydı olmadan başlamaz; kayıt yoksa ilk kaydetmede yazılır.
  const cropStored = project.readiness?.video?.ready ?? project.projectJson?.data?.video?.cropBottom !== undefined;
  const currentClipName = fileName(currentClip);
  const clipMissing = Boolean(project.clip?.value) && !project.clip?.exists;

  const backendVideo = project.projectJson?.data?.video;
  const backendCropBottom = backendVideo?.cropBottom ?? 150;
  const backendCropTop = backendVideo?.cropTop ?? 0;
  const backendCropLeft = backendVideo?.cropLeft ?? 0;
  const backendCropRight = backendVideo?.cropRight ?? 0;
  const backendWatermark = backendVideo?.watermark ?? (backendCropBottom > 0 || backendCropTop > 0 || backendCropLeft > 0 || backendCropRight > 0);

  const [selected, setSelected] = useState<string | null>(suggestedClip);
  const [cropBottom, setCropBottom] = useState<number>(backendCropBottom);
  const [cropTop, setCropTop] = useState<number>(backendCropTop);
  const [cropLeft, setCropLeft] = useState<number>(backendCropLeft);
  const [cropRight, setCropRight] = useState<number>(backendCropRight);

  const [cropBottomInput, setCropBottomInput] = useState<string>(String(backendCropBottom));
  const [cropTopInput, setCropTopInput] = useState<string>(String(backendCropTop));
  const [cropLeftInput, setCropLeftInput] = useState<string>(String(backendCropLeft));
  const [cropRightInput, setCropRightInput] = useState<string>(String(backendCropRight));

  const [watermark, setWatermark] = useState<boolean>(backendWatermark);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Synchronize state when project updates from backend
  useEffect(() => {
    const freshBottom = project.projectJson?.data?.video?.cropBottom ?? 150;
    const freshTop = project.projectJson?.data?.video?.cropTop ?? 0;
    const freshLeft = project.projectJson?.data?.video?.cropLeft ?? 0;
    const freshRight = project.projectJson?.data?.video?.cropRight ?? 0;
    const freshWatermark = project.projectJson?.data?.video?.watermark ?? (freshBottom > 0 || freshTop > 0 || freshLeft > 0 || freshRight > 0);

    setCropBottom(freshBottom);
    setCropTop(freshTop);
    setCropLeft(freshLeft);
    setCropRight(freshRight);

    setCropBottomInput(String(freshBottom));
    setCropTopInput(String(freshTop));
    setCropLeftInput(String(freshLeft));
    setCropRightInput(String(freshRight));

    setWatermark(freshWatermark);
    setSelected(suggestedClip ?? null);
  }, [suggestedClip, project.projectJson?.data?.video]);

  const chosenPath = selected || currentClip;
  const chosenName = fileName(chosenPath);
  const hasClipChange = selected !== currentClip;
  const hasSettingsChange =
    cropBottom !== backendCropBottom ||
    cropTop !== backendCropTop ||
    cropLeft !== backendCropLeft ||
    cropRight !== backendCropRight ||
    watermark !== backendWatermark ||
    !cropStored;
  const canSave = Boolean(chosenName) && (hasClipChange || hasSettingsChange) && !validationError && !isSaving;

  // Determine active preview: load URL for currently selected candidate or saved clip
  const previewName = chosenName ?? currentClipName;
  const previewUrl = previewName ? getProjectClipUrl(project.id, previewName) : null;

  const handleApplyPreset = (b: number, t: number, l: number, r: number) => {
    setCropBottom(b);
    setCropTop(t);
    setCropLeft(l);
    setCropRight(r);

    setCropBottomInput(String(b));
    setCropTopInput(String(t));
    setCropLeftInput(String(l));
    setCropRightInput(String(r));

    setWatermark(b > 0 || t > 0 || l > 0 || r > 0);
    setValidationError(null);
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    if (!chosenName || isSaving || validationError) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);

    const effectiveBottom = watermark ? cropBottom : 0;
    const effectiveTop = watermark ? cropTop : 0;
    const effectiveLeft = watermark ? cropLeft : 0;
    const effectiveRight = watermark ? cropRight : 0;
    const effectiveWatermark = watermark && (effectiveBottom > 0 || effectiveTop > 0 || effectiveLeft > 0 || effectiveRight > 0);

    try {
      let updatedProject: ProjectDetail = project;

      // 1. If clip changed or wasn't set, select clip via PUT /api/projects/:id/clip
      if (hasClipChange && chosenName) {
        updatedProject = await selectProjectClip(project.id, chosenName);
      }

      // 2. If crop / watermark settings changed, update via PUT /api/projects/:id/crop
      if (hasSettingsChange) {
        try {
          updatedProject = await updateProjectCrop(project.id, {
            watermark: effectiveWatermark,
            cropBottom: effectiveBottom,
            cropTop: effectiveTop,
            cropLeft: effectiveLeft,
            cropRight: effectiveRight,
          });
        } catch (cropErr: unknown) {
          if (cropErr instanceof ApiError && cropErr.status === 404) {
            updatedProject = {
              ...updatedProject,
              projectJson: {
                ...updatedProject.projectJson,
                data: {
                  ...updatedProject.projectJson?.data,
                  video: {
                    ...updatedProject.projectJson?.data?.video,
                    cropBottom: effectiveBottom,
                    cropTop: effectiveTop,
                    cropLeft: effectiveLeft,
                    cropRight: effectiveRight,
                    watermark: effectiveWatermark,
                  },
                },
              },
            };
          } else {
            throw cropErr;
          }
        }
      }

      if (onProjectUpdate) {
        onProjectUpdate(updatedProject);
      }
      setSuccess(`${isStill ? 'Görsel' : 'Klip'} seçildi, kırpma ve 16:9 ayarı proje ayarlarına kaydedildi.`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Could not save video settings.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder(project.id, mediaFolder);
      setSuccess(`Opened ${mediaFolder}/ folder in Explorer.`);
    } catch {
      setError('Could not open folder in Explorer.');
    }
  };

  const handleRefreshClips = async () => {
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setSuccess(`Refreshed ${isStill ? 'images' : 'clips'} from ${mediaFolder}/ folder.`);
    } catch {
      setError('Could not refresh clips.');
    }
  };

  const handleNumberChange = (
    val: string,
    setter: (n: number) => void,
    inputSetter: (s: string) => void,
    fieldLabel: string,
  ) => {
    inputSetter(val);
    setError(null);
    setSuccess(null);
    if (val.trim() === '') {
      setValidationError(`${fieldLabel} is required.`);
    } else {
      const num = Number(val);
      if (!Number.isInteger(num) || num < 0) {
        setValidationError(`${fieldLabel} must be 0 or a positive integer.`);
      } else if (num > 2160) {
        setValidationError(`${fieldLabel} cannot exceed 2160px.`);
      } else {
        setValidationError(null);
        setter(num);
      }
    }
  };

  return (
    <StagePanel section="video" title="4. Video" status={assets.clip} stageStatus={stageStatus}>
      <div className="stage-media">
        <AssetPreview
          kind={isStill ? 'image' : 'video'}
          fileName={previewName}
          src={previewUrl}
          emptyLabel={
            clipMissing
              ? `Configured clip not found: ${project.clip?.value}`
              : isStill
                ? 'No image yet. Save the master frame as resimler\\MASTER.png.'
                : 'No clip selected. Put the loop clip (.mp4) under videolar\\.'
          }
        />
        <div className="stage-actions">
          {isStill ? (
            <p className="field-hint">
              Tek resim modu: seçilen görsel videonun tamamı boyunca ekranda kalır. Klip üretmeye gerek yok.
            </p>
          ) : (
            <>
              <p className="field-hint">
                Görsel: {fileName(project.master) ?? 'master frame yok'}
                {(project.angles?.length ?? 0) > 0 ? ` (ya da açı görselleri: ${project.angles?.map((path) => fileName(path)).join(', ')})` : ''}
              </p>
              <UploadButton
                label="Video klibi yükle (.mp4)"
                accept=".mp4"
                multiple
                onFiles={async (files) => {
                  let latest = project;
                  for (const file of files) latest = await uploadProjectClip(project.id, file);
                  onProjectUpdate?.(latest);
                }}
              />
            </>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '12px 0 8px' }}>
            <h3 style={{ margin: 0 }}>
              {isStill ? 'Images' : 'Clips in folder'} <span className="count">({clips.length})</span>
            </h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, minHeight: 26, padding: '2px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={handleOpenFolder}
              >
                📂 Open Folder
              </button>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
                onClick={handleRefreshClips}
              >
                🔄 Refresh
              </button>
            </div>
          </div>
          <p className="field-hint" style={{ margin: '0 0 10px' }}>
            {isStill
              ? <>MASTER and angle images (<code>Master1.jpg</code> …) from</>
              : <>Put loop video files (<code>.mp4</code>) into</>}{' '}
            <code
              onClick={handleOpenFolder}
              title={`Click to open ${mediaFolder}\ folder in Windows Explorer`}
              style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
            >
              {project.dir || project.name}\{mediaFolder}\
            </code>.
          </p>
          {clips.length > 0 ? (
            <div className="option-list" role="radiogroup" aria-label={isStill ? 'Images' : 'Video clips'}>
              {clips.map((path) => {
                const name = fileName(path);
                const isCurrent = path === currentClip || name === currentClipName;
                return (
                  <label key={path} className={selected === path ? 'option selected' : 'option'}>
                    <input
                      type="radio"
                      name={`clip-${project.id}`}
                      checked={selected === path}
                      disabled={isSaving}
                      onChange={() => {
                        setSelected(path);
                        setError(null);
                        setSuccess(null);
                      }}
                    />
                    <span>{name}</span>
                    {isCurrent ? <StatusBadge status="selected" label="In use" /> : null}
                  </label>
                );
              })}
            </div>
          ) : (
            <EmptyState compact title={isStill ? 'No MASTER image in resimler\\ yet.' : 'No .mp4 clips in videolar\\.'} />
          )}

          <div style={{ marginTop: 14, width: '100%', borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
              <h3 style={{ margin: 0 }}>Watermark & Kenar Kırpma (Çok Yönlü)</h3>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: 11.5, minHeight: 24, padding: '2px 8px' }}
                  onClick={() => handleApplyPreset(150, 0, 0, 0)}
                >
                  🎯 Hailuo (Alt: 150px)
                </button>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: 11.5, minHeight: 24, padding: '2px 8px' }}
                  onClick={() => handleApplyPreset(0, 0, 0, 0)}
                >
                  🔄 Sıfırla (0px)
                </button>
              </div>
            </div>

            <label className="option" style={{ marginBottom: 10 }}>
              <input
                type="checkbox"
                checked={watermark}
                disabled={isSaving}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setWatermark(checked);
                  setError(null);
                  setSuccess(null);
                  if (checked && cropBottom === 0 && cropTop === 0 && cropLeft === 0 && cropRight === 0) {
                    setCropBottom(150);
                    setCropBottomInput('150');
                  }
                }}
              />
              <span>Kenar / Watermark kırpmayı etkinleştir</span>
            </label>

            {/* Directional 4-side inputs */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                background: 'var(--bg-surface-subtle)',
                border: '1px solid var(--border-subtle)',
                opacity: watermark ? 1 : 0.6,
              }}
            >
              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600 }}>⬆️ Üstten Kırp (Top px)</label>
                <input
                  type="number"
                  min={0}
                  max={2160}
                  value={cropTopInput}
                  disabled={!watermark || isSaving}
                  onChange={(e) => handleNumberChange(e.target.value, setCropTop, setCropTopInput, 'Top crop')}
                  style={{ padding: '6px 8px', fontSize: 13 }}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600 }}>⬇️ Alttan Kırp (Bottom px)</label>
                <input
                  type="number"
                  min={0}
                  max={2160}
                  value={cropBottomInput}
                  disabled={!watermark || isSaving}
                  onChange={(e) => handleNumberChange(e.target.value, setCropBottom, setCropBottomInput, 'Bottom crop')}
                  style={{ padding: '6px 8px', fontSize: 13 }}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600 }}>⬅️ Soldan Kırp (Left px)</label>
                <input
                  type="number"
                  min={0}
                  max={2160}
                  value={cropLeftInput}
                  disabled={!watermark || isSaving}
                  onChange={(e) => handleNumberChange(e.target.value, setCropLeft, setCropLeftInput, 'Left crop')}
                  style={{ padding: '6px 8px', fontSize: 13 }}
                />
              </div>

              <div className="field" style={{ margin: 0 }}>
                <label style={{ fontSize: 12.5, fontWeight: 600 }}>➡️ Sağdan Kırp (Right px)</label>
                <input
                  type="number"
                  min={0}
                  max={2160}
                  value={cropRightInput}
                  disabled={!watermark || isSaving}
                  onChange={(e) => handleNumberChange(e.target.value, setCropRight, setCropRightInput, 'Right crop')}
                  style={{ padding: '6px 8px', fontSize: 13 }}
                />
              </div>
            </div>

            {/* 16:9 Guarantee Banner */}
            <div
              style={{
                marginTop: 10,
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-subtle)',
                fontSize: 12,
                color: 'var(--text-muted)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 16 }}>📐</span>
              <div>
                <strong style={{ color: 'var(--text-main)', display: 'block' }}>
                  Otomatik 16:9 Format Garantisi
                </strong>
                Kenarlardan istediğiniz kadar piksel kırpın; pipeline videoyu merkezden otomatik olarak tam 16:9 oranına tamamlayacaktır.
              </div>
            </div>
          </div>

          {validationError ? (
            <p className="field-hint field-error" role="alert" style={{ marginTop: 8 }}>
              {validationError}
            </p>
          ) : null}

          {error ? (
            <p className="field-hint field-error" role="alert" style={{ marginTop: 8 }}>
              {error}
            </p>
          ) : null}

          {success ? (
            <p className="field-hint" style={{ marginTop: 8, color: '#34603f' }}>
              ✓ {success}
            </p>
          ) : null}

          <div style={{ marginTop: 12 }}>
            <button
              className="button button-primary"
              type="button"
              disabled={!canSave || isSaving}
              onClick={handleSave}
            >
              {isSaving
                ? 'Saving...'
                : hasClipChange
                  ? currentClip
                    ? (isStill ? 'Görseli değiştir ve kaydet' : 'Klibi değiştir ve kaydet')
                    : (isStill ? 'Seçilen görseli kullan ve kaydet' : 'Seçilen klibi kullan ve kaydet')
                  : 'Video ayarlarını kaydet'}
            </button>
          </div>
        </div>
      </div>
    </StagePanel>
  );
}

export function MusicStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const music = project.projectJson?.data?.music;
  const tracks = musicTracks(project);
  const readinessMusic = project.readiness?.music;
  const audioCount = readinessMusic ? readinessMusic.audioCount : (project.audioCount ?? 0);
  const trackCount = readinessMusic ? readinessMusic.trackCount : (music?.totalTracks ?? tracks.length);
  const completedCount = readinessMusic
    ? readinessMusic.completedTrackCount
    : (music?.completedCount ?? tracks.filter((t) => t.status === 'completed').length);

  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completeSuccess, setCompleteSuccess] = useState<string | null>(null);

  // Inline Suno downloader state
  const [showSunoBox, setShowSunoBox] = useState(false);
  const [sunoUrl, setSunoUrl] = useState('');
  const [isIngestingSuno, setIsIngestingSuno] = useState(false);
  const [sunoIngestError, setSunoIngestError] = useState<string | null>(null);
  const [sunoIngestSuccess, setSunoIngestSuccess] = useState<string | null>(null);

  // Yüklenen dosyaların listesi (audioDir) — plan olmayan projede de adlar görünsün.
  const [musicInfo, setMusicInfo] = useState<ProjectMusicInfo | null>(null);
  useEffect(() => {
    let active = true;
    fetchProjectMusic(project.id)
      .then((info) => {
        if (active) setMusicInfo(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [project.id, audioCount]);

  // Album Library picker state
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [libraryAlbums, setLibraryAlbums] = useState<Array<{ id: string; name: string; trackCount: number }>>([]);
  const [isImportingAlbum, setIsImportingAlbum] = useState(false);

  useEffect(() => {
    fetchMusicLibrary()
      .then((lib) => {
        setLibraryAlbums(lib.albums.map((a) => ({ id: a.id, name: a.name, trackCount: a.trackCount })));
      })
      .catch(() => {});
  }, []);

  const handleImportAlbum = async (albumId: string) => {
    setIsImportingAlbum(true);
    setCompleteError(null);
    setCompleteSuccess(null);
    try {
      const res = await assignAlbumToProject({ albumId, projectId: project.id });
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess(`✓ "${albumId}" albümünden ${res.copiedCount} parça projeye başarıyla aktarıldı.`);
      setShowAlbumPicker(false);
    } catch (err: unknown) {
      setCompleteError(err instanceof Error ? err.message : 'Albüm aktarılamadı.');
    } finally {
      setIsImportingAlbum(false);
    }
  };

  const isMusicReady = readinessMusic?.ready ?? (assets.music === 'ready');
  const missingTracksCount = Math.max(0, trackCount - audioCount);

  const handleDownloadSuno = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sunoUrl.trim() || isIngestingSuno) return;
    setIsIngestingSuno(true);
    setSunoIngestError(null);
    setSunoIngestSuccess(null);
    try {
      const res = await ingestSunoToProject(project.id, sunoUrl.trim());
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setSunoIngestSuccess(`✓ ${res.downloadedCount} parça Suno'dan indirildi ve projeye bağlandı!`);
      setSunoUrl('');
    } catch (err: unknown) {
      setSunoIngestError(err instanceof Error ? err.message : 'Suno indirme başarısız oldu.');
    } finally {
      setIsIngestingSuno(false);
    }
  };

  const handleCompleteMusic = async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    setCompleteError(null);
    setCompleteSuccess(null);

    try {
      const updated = await completeProjectMusic(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess('Music stage marked as completed.');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setCompleteError(err.message);
      } else {
        setCompleteError(err instanceof Error ? err.message : 'Music could not be completed.');
      }
    } finally {
      setIsCompleting(false);
    }
  };

  const handleRefresh = async () => {
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess('Refreshed audio directory status.');
    } catch {
      setCompleteError('Could not refresh audio tracks.');
    }
  };

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder(project.id, 'audio');
      setCompleteSuccess('Opened audio/ folder in Explorer.');
    } catch {
      setCompleteError('Could not open folder in Explorer.');
    }
  };

  return (
    <StagePanel section="music" title="5. Müzik" status={assets.music} stageStatus={stageStatus}>
      <UploadButton
        label="Müzik dosyalarını yükle"
        accept=".mp3,.wav,.m4a,.flac,.aac,.opus,.ogg"
        multiple
        onFiles={async (files) => {
          let latest = project;
          for (const file of files) latest = await uploadProjectAudio(project.id, file);
          onProjectUpdate?.(latest);
        }}
      />
      <p className="field-hint">
        <strong>{audioCount} parça yüklendi.</strong>
      </p>
      <div className="music-summary">
        {music?.concept ? (
          <p>
            <span className="muted">Concept</span> {music.concept}
          </p>
        ) : null}
        <p>
          <strong>{trackCount > 0 ? `${trackCount} Tracks Planned` : `${audioCount} Audio Files`}</strong>
          <span className="muted">
            {' '}
            · {audioCount} of {trackCount || audioCount} audio files present
            {trackCount > 0 && missingTracksCount > 0 ? ` (${missingTracksCount} remaining)` : ''}
            {completedCount > 0 ? ` · ${completedCount} marked completed` : ''}
            {isMusicReady
              ? ' · Status: Completed'
              : audioCount === 0
                ? ' · Status: Awaiting audio files'
                : ' · Status: In progress'}
          </span>
        </p>
      </div>

      {/* Suno Downloader Accordion / Box */}
      {showSunoBox ? (
        <div
          style={{
            margin: '12px 0 16px',
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🌐</span> Suno Linkinden Otomatik İndir (Suno Ingest)
            </strong>
            <button
              type="button"
              className="button"
              style={{ fontSize: 11, minHeight: 22, padding: '0 6px' }}
              onClick={() => setShowSunoBox(false)}
            >
              Kapat
            </button>
          </div>
          <form onSubmit={handleDownloadSuno} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="url"
                placeholder="https://suno.com/playlist/... veya https://suno.com/song/..."
                value={sunoUrl}
                onChange={(e) => setSunoUrl(e.target.value)}
                disabled={isIngestingSuno}
                style={{ flex: 1, fontSize: 13, padding: '6px 10px' }}
                required
              />
              <button
                type="submit"
                className="button button-primary"
                disabled={isIngestingSuno || !sunoUrl.trim()}
                style={{ fontSize: 13, minHeight: 32 }}
              >
                {isIngestingSuno ? 'İndiriliyor...' : 'İndir & Bağla'}
              </button>
            </div>
            {sunoIngestError ? (
              <p className="field-hint field-error" role="alert" style={{ margin: 0 }}>
                {sunoIngestError}
              </p>
            ) : null}
            {sunoIngestSuccess ? (
              <p className="field-hint" style={{ color: '#34603f', margin: 0, fontWeight: 600 }}>
                {sunoIngestSuccess}
              </p>
            ) : null}
          </form>
        </div>
      ) : null}

      {/* Album Library Picker Box */}
      {showAlbumPicker ? (
        <div
          style={{
            margin: '12px 0 16px',
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>📚</span> Müzik Kütüphanesinden Albüm Seç & Bu Projeye Aktar
            </strong>
            <button
              type="button"
              className="button"
              style={{ fontSize: 11, minHeight: 22, padding: '0 6px' }}
              onClick={() => setShowAlbumPicker(false)}
            >
              Kapat
            </button>
          </div>
          {libraryAlbums.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {libraryAlbums.map((album) => (
                <div
                  key={album.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: 13 }}>📁 {album.name}</strong>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                      ({album.trackCount} parça)
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={isImportingAlbum || album.trackCount === 0}
                    style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
                    onClick={() => handleImportAlbum(album.id)}
                  >
                    {isImportingAlbum ? 'Aktarılıyor...' : 'Bu Albümü Projeye Aktar'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="field-hint" style={{ margin: 0 }}>
              Kütüphanede henüz albüm yok. Üst menüdeki <strong>Music Hub</strong> üzerinden albüm ekleyebilirsiniz.
            </p>
          )}
        </div>
      ) : null}

      {tracks.length > 0 ? (
        <TrackList tracks={tracks} />
      ) : musicInfo && musicInfo.audioFiles.length > 0 ? (
        <ol className="order-list">
          {musicInfo.audioFiles.map((audio, index) => (
            <li key={audio.file}>
              <span className="order-number">{index + 1}</span>
              <span className="order-name">{audio.file}</span>
            </li>
          ))}
        </ol>
      ) : audioCount > 0 ? (
        <EmptyState compact title="Track names are not available.">
          {audioCount} audio files found in{' '}
          <code
            onClick={handleOpenFolder}
            title="Click to open audio folder in Windows Explorer"
            style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
          >
            {project.audioDir ?? 'the audio folder'}
          </code>.
        </EmptyState>
      ) : (
        <EmptyState compact title="No music tracks yet.">
          Put Suno audio files (.mp3, .wav, .m4a, .flac) in{' '}
          <code
            onClick={handleOpenFolder}
            title="Click to open audio folder in Windows Explorer"
            style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
          >
            {project.audioDir ?? 'the audio folder'}
          </code>.
        </EmptyState>
      )}

      {completeError ? (
        <p className="field-hint field-error" role="alert" style={{ marginTop: 12 }}>
          {completeError}
        </p>
      ) : null}

      {completeSuccess ? (
        <p className="field-hint" style={{ color: '#34603f', marginTop: 12 }}>
          ✓ {completeSuccess}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowAlbumPicker((prev) => !prev)}
        >
          📚 {showAlbumPicker ? 'Albümleri Gizle' : 'Kütüphaneden Albüm Seç'}
        </button>
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowSunoBox((prev) => !prev)}
        >
          🌐 {showSunoBox ? 'Suno Alanını Gizle' : 'Suno Linkinden İndir'}
        </button>
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={handleOpenFolder}
        >
          📂 Open audio/ Folder
        </button>
        {!isMusicReady ? (
          <button
            className="button button-primary"
            type="button"
            disabled={isCompleting || audioCount === 0}
            onClick={handleCompleteMusic}
          >
            {isCompleting ? 'Completing music...' : 'Complete Music & Continue'}
          </button>
        ) : null}
        <button
          className="button"
          type="button"
          disabled={isCompleting}
          onClick={handleRefresh}
        >
          🔄 Refresh Audio Files
        </button>
      </div>

      {!isMusicReady && audioCount === 0 ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          ℹ Add at least 1 audio file (.mp3, .wav) to the audio folder, import an album, or download with Suno above to continue.
        </p>
      ) : null}
    </StagePanel>
  );
}

type BuildOpState = 'pending' | 'running' | 'done' | 'failed';

/**
 * Canonical 9. adımın 7 otomatik işlemi ve build.js'teki karşılığı (tag).
 * build.js her adım için "[tag] <ad> başlıyor." / "[tag] <ad> bitti: …"
 * yazar; çalışma sırası 01 → 02 → 04 → 03 → 05 olduğundan durum sıradan
 * bağımsız, satırlardan okunur.
 */
const BUILD_OPERATIONS = [
  { label: "Watermark'ı kırp", tag: '01' },
  { label: 'Video oranını düzelt (16:9)', tag: '01' },
  { label: 'Sesleri birleştir', tag: '02' },
  { label: 'Ambient sesi ekle', tag: '03' },
  { label: 'Videoyu ses süresine uzat', tag: '04' },
  { label: 'Fade işlemlerini uygula', tag: '04' },
  { label: 'Tracklist üret', tag: '05' },
] as const;

const OP_ICON: Record<BuildOpState, string> = { pending: '○', running: '⏳', done: '✓', failed: '✗' };

function buildChecklist(log: string[] = [], state?: string) {
  const has = (tag: string, word: string) => log.some((line) => line.startsWith(`[${tag}]`) && line.includes(word));
  const ambientSkipped = log.some((line) => line.includes('Ambient tanımlı değil'));
  const tagState = (tag: string): BuildOpState => {
    if (state === 'succeeded') return 'done';
    // Ambient birden fazla karışım olabilir: tracklist başladıysa bitmiştir.
    const finished = tag === '03' ? ambientSkipped || has('05', 'başlıyor') : has(tag, 'bitti');
    if (finished) return 'done';
    if (has(tag, 'başlıyor')) return state === 'failed' ? 'failed' : 'running';
    return 'pending';
  };
  const items = BUILD_OPERATIONS.map((op) => ({ label: op.label, state: tagState(op.tag) }));
  const doneCount = items.filter((item) => item.state === 'done').length;
  const active = items.find((item) => item.state === 'running' || item.state === 'failed');
  const percent = state === 'succeeded' ? 100 : Math.max(5, Math.round((doneCount / items.length) * 100));
  let stepLabel = 'Montaj başlatılıyor...';
  if (state === 'succeeded') stepLabel = 'Montaj tamamlandı';
  else if (state === 'failed') stepLabel = active ? `Montaj başarısız: ${active.label}` : 'Montaj başarısız';
  else if (active) stepLabel = `${active.label} (${doneCount}/${items.length})`;
  return { items, percent, stepLabel };
}

export function BuildStage({ project, assets, stageStatus, onProjectUpdate, onGoToStep }: StageProps) {
  const readiness = project.readiness;
  const isBuildReady = readiness?.build?.ready ?? (assets.assembly === 'ready');
  const canBuild = isBuildReady;
  const missingRequirements = readiness?.build?.missing ?? [];

  const [buildJob, setBuildJob] = useState<BuildJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const rows = [
    { label: 'Master Frame', status: assets.master },
    { label: 'Video Clip', status: assets.clip },
    { label: 'Music', status: assets.music },
  ];

  // Initial fetch of build status
  useEffect(() => {
    let isActive = true;
    fetchBuildStatus(project.id)
      .then((job) => {
        if (!isActive) return;
        setBuildJob(job);
        if (job.state === 'succeeded' && !project.output?.exists) {
          fetchProject(project.id)
            .then((updated) => {
              if (isActive && onProjectUpdate) {
                onProjectUpdate(updated);
              }
            })
            .catch(() => {});
        }
      })
      .catch(() => {
        // ignore
      });
    return () => {
      isActive = false;
    };
  }, [project.id, project.output?.exists, onProjectUpdate]);

  // Polling when buildJob is running
  useEffect(() => {
    if (buildJob?.state !== 'running') return;

    let isActive = true;
    const intervalId = setInterval(() => {
      fetchBuildStatus(project.id)
        .then((job) => {
          if (!isActive) return;
          setBuildJob(job);
          if (job.state === 'succeeded') {
            fetchProject(project.id)
              .then((updated) => {
                if (isActive && onProjectUpdate) {
                  onProjectUpdate(updated);
                }
              })
              .catch(() => {
                // ignore
              });
          }
        })
        .catch(() => {
          // ignore
        });
    }, 1500);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [buildJob?.state, project.id, onProjectUpdate]);

  const handleStartBuild = async () => {
    if (isStarting || buildJob?.state === 'running') return;
    setIsStarting(true);
    setBuildError(null);

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    try {
      const job = await startBuild(project.id, { overwrite: Boolean(project.output?.exists) });
      setBuildJob(job);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setBuildError(err.message);
      } else {
        setBuildError(err instanceof Error ? err.message : 'Build could not be started.');
      }
    } finally {
      setIsStarting(false);
    }
  };

  const isRunning = buildJob?.state === 'running';
  const isSucceeded = buildJob?.state === 'succeeded' || (project.output?.exists && !isRunning);
  const progress = buildChecklist(buildJob?.log, buildJob?.state);

  const videoConfig = project.projectJson?.data?.video;
  const configuredCropBottom = videoConfig?.cropBottom ?? 150;
  const configuredCropTop = videoConfig?.cropTop ?? 0;
  const configuredCropLeft = videoConfig?.cropLeft ?? 0;
  const configuredCropRight = videoConfig?.cropRight ?? 0;
  const hasCrop = (videoConfig?.watermark ?? false) && (configuredCropBottom > 0 || configuredCropTop > 0 || configuredCropLeft > 0 || configuredCropRight > 0);

  const cropDescription = hasCrop
    ? [
        configuredCropBottom > 0 ? `Alt: ${configuredCropBottom}px` : null,
        configuredCropTop > 0 ? `Üst: ${configuredCropTop}px` : null,
        configuredCropLeft > 0 ? `Sol: ${configuredCropLeft}px` : null,
        configuredCropRight > 0 ? `Sağ: ${configuredCropRight}px` : null,
      ].filter(Boolean).join(', ')
    : 'Kırpma yok';

  return (
    <StagePanel section="build" title="7. Montaj" status={assets.assembly} stageStatus={stageStatus}>
      <dl className="readiness-list">
        {rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              <StatusBadge status={row.status} />
            </dd>
          </div>
        ))}
        <div>
          <dt>Video Crop & Format</dt>
          <dd>
            {cropDescription} → 16:9
          </dd>
        </div>
      </dl>

      {!isBuildReady ? (
        <p className="field-hint" style={{ marginTop: 12, color: 'var(--text-muted)' }}>
          ℹ Build will be available when all required stages (Master Frame, Video Clip, Music) are ready.
        </p>
      ) : null}

      {buildError ? (
        <p className="field-hint field-error" role="alert" style={{ marginTop: 12 }}>
          {buildError}
        </p>
      ) : null}

      {/* Progress bar during build */}
      {isRunning || buildJob?.state === 'failed' ? (
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            borderRadius: 8,
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>
              {isRunning ? '⏳' : '✗'} {progress.stepLabel}
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)' }}>
              %{progress.percent}
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: 10,
              borderRadius: 5,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress.percent}%`,
                height: '100%',
                borderRadius: 5,
                background: 'linear-gradient(90deg, #4caf50, #2e7d32)',
                transition: 'width 0.5s ease',
              }}
            />
          </div>
          <ol className="build-ops">
            {progress.items.map((item) => (
              <li key={item.label} className={`build-op ${item.state}`}>
                <span aria-hidden="true">{OP_ICON[item.state]}</span> {item.label}
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {isSucceeded ? (
        <div
          style={{
            marginTop: 16,
            padding: '14px 18px',
            borderRadius: 8,
            backgroundColor: 'var(--bg-surface-subtle)',
            border: '1px solid #34603f',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 26 }} role="img" aria-label="party popper">🎉</span>
            <div>
              <strong style={{ fontSize: 15, color: '#34603f', display: 'block' }}>
                Video Başarıyla Oluşturuldu!
              </strong>
              <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Nihai video <code>out/final_ambient.mp4</code> olarak hazırlandı.
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="button button-primary"
              style={{ fontSize: 12.5, minHeight: 30, padding: '2px 12px' }}
              onClick={() => onGoToStep?.('publish')}
            >
              ▶️ Yayın adımına geç
            </button>
            <button
              type="button"
              className="button"
              style={{ fontSize: 12.5, minHeight: 30, padding: '2px 12px' }}
              onClick={() => openProjectFolder(project.id, 'out')}
            >
              📂 Çıktı Klasörünü Aç
            </button>
          </div>
        </div>
      ) : null}

      {buildJob && buildJob.state !== 'idle' ? (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong>Build status:</strong>
            {buildJob.state === 'running' ? (
              <StatusBadge status="processing" label="Running" />
            ) : buildJob.state === 'succeeded' ? (
              <StatusBadge status="completed" label="Succeeded" />
            ) : buildJob.state === 'failed' ? (
              <StatusBadge status="failed" label="Failed" />
            ) : null}
          </div>

          {buildJob.error ? (
            <p className="field-hint field-error" role="alert" style={{ marginTop: 4 }}>
              {buildJob.error}
            </p>
          ) : null}

          {buildJob.state === 'failed' && buildJob.errorLog && buildJob.errorLog.length > 0 ? (
            <pre className="build-log">{buildJob.errorLog.slice(-15).join('\n')}</pre>
          ) : null}

          {buildJob.log && buildJob.log.length > 0 ? (
            <pre className="build-log">
              {buildJob.log.slice(-10).join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}

      <div className="stage-footer">
        <button
          className="button button-primary"
          type="button"
          disabled={!canBuild || isRunning || isStarting}
          onClick={handleStartBuild}
        >
          {isRunning
            ? 'Montaj sürüyor...'
            : isStarting
              ? 'Başlatılıyor...'
              : project.output?.exists
                ? 'Yeniden başlat'
                : 'Başlat'}
        </button>

        {!canBuild && !project.output?.exists && !isRunning ? (
          <p className="field-hint">
            {missingRequirements.length > 0
              ? `Required assets missing: ${missingRequirements.join(', ')}`
              : 'Available when audio and video are ready.'}
          </p>
        ) : null}
      </div>
    </StagePanel>
  );
}

export function OutputStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const outputName = fileName(project.output?.path);
  const tracklist = project.readiness?.output?.tracklist;
  const outputUrl = project.output?.exists && outputName ? getProjectOutputUrl(project.id, outputName) : null;
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefreshOutput = async () => {
    setIsRefreshing(true);
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
    } catch {
      // ignore
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <StagePanel section="publish" title="8. Yayın" status={assets.output} stageStatus={stageStatus}>
      {project.output?.exists ? (
        <div className="stage-media">
          <AssetPreview kind="video" fileName={outputName} src={outputUrl} emptyLabel="" />
          <div className="stage-actions">
            <dl className="readiness-list">
              <div>
                <dt>Output</dt>
                <dd>{outputName}</dd>
              </div>
              <div>
                <dt>Audio files</dt>
                <dd>{project.audioCount ?? 0}</dd>
              </div>
              <div>
                <dt>Output Path</dt>
                <dd><code>{project.output?.path ?? 'out/final_ambient.mp4'}</code></dd>
              </div>
            </dl>

            <CopyPrompt
              label="Tracklist (YouTube açıklaması)"
              buttonLabel="Tracklist'i kopyala"
              prompt={tracklist?.text}
              error={tracklist?.exists ? 'Tracklist okunamadı.' : 'Tracklist dosyası bulunamadı — montajı yeniden başlat.'}
            />

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                type="button"
                className="button button-primary"
                onClick={() => openProjectFolder(project.id, 'out')}
              >
                📂 Çıktı Klasörünü Aç (Explorer)
              </button>
              {outputUrl ? (
                <a
                  href={outputUrl}
                  download={outputName || 'final_ambient.mp4'}
                  className="button"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                  ⬇️ İndir (MP4)
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <EmptyState compact title="No output yet.">
            The video will be assembled and written to <code>{outputName ?? 'out/final_ambient.mp4'}</code> when build completes.
          </EmptyState>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button"
              disabled={isRefreshing}
              onClick={handleRefreshOutput}
            >
              {isRefreshing ? 'Checking out/...' : '🔄 Çıktıyı Kontrol Et / Yenile'}
            </button>
          </div>
        </div>
      )}
    </StagePanel>
  );
}

