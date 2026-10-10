/** 2. adım — Video: döngü klibi / tek görsel seçimi, kırpma ve format. */
import { useEffect, useState } from 'react';
import {
  fetchProject,
  getProjectClipUrl,
  openProjectFolder,
  selectProjectClip,
  updateProjectCrop,
  updateProjectVideoSource,
  uploadProjectClip,
  uploadProjectImage,
  ApiError,
} from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import type { ProjectDetail, VideoSource } from '../../types';
import { fileName } from './assetState';
import { UploadButton } from './StepWidgets';
import { StagePanel, type StageProps } from './StagePanel';

export function VideoStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  // Tek resim modu: clips = resimler\ altındaki bütün görseller (sunucu ada göre sıralar).
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

  const backendAspect = project.projectJson?.data?.video?.aspect || '16:9';
  const [aspect, setAspect] = useState<string>(backendAspect);

  const [watermark, setWatermark] = useState<boolean>(backendWatermark);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSwitchingSource, setIsSwitchingSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Synchronize state when project updates from backend
  useEffect(() => {
    const freshBottom = project.projectJson?.data?.video?.cropBottom ?? 150;
    const freshTop = project.projectJson?.data?.video?.cropTop ?? 0;
    const freshLeft = project.projectJson?.data?.video?.cropLeft ?? 0;
    const freshRight = project.projectJson?.data?.video?.cropRight ?? 0;
    const freshWatermark = project.projectJson?.data?.video?.watermark ?? (freshBottom > 0 || freshTop > 0 || freshLeft > 0 || freshRight > 0);
    const freshAspect = project.projectJson?.data?.video?.aspect || '16:9';

    setCropBottom(freshBottom);
    setCropTop(freshTop);
    setCropLeft(freshLeft);
    setCropRight(freshRight);
    setAspect(freshAspect);

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
  const hasAspectChange = aspect !== backendAspect;
  const hasSettingsChange =
    cropBottom !== backendCropBottom ||
    cropTop !== backendCropTop ||
    cropLeft !== backendCropLeft ||
    cropRight !== backendCropRight ||
    watermark !== backendWatermark ||
    hasAspectChange ||
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
            aspect,
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
                    aspect,
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
      setSuccess(`${isStill ? 'Görsel' : 'Klip'} seçildi, kırpma ve ${aspect} format ayarı proje ayarlarına kaydedildi.`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Video ayarları kaydedilemedi. Tekrar dene.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder(project.id, mediaFolder);
      setSuccess(`${mediaFolder}/ klasörü Explorer’da açıldı.`);
    } catch {
      setError('Klasör açılamadı. Proje klasörü taşınmış ya da silinmiş olabilir.');
    }
  };

  /**
   * Kaynağı değiştir: tek resim ↔ döngü videosu. Seçim yeni moda uymuyorsa
   * sunucu onu boşaltır ve uyarı döner — sessizce kaybolmasın diye basılır.
   */
  const handleSwitchSource = async (next: VideoSource) => {
    if (next === project.videoSource) return;
    setError(null);
    setSuccess(null);
    setIsSwitchingSource(true);
    try {
      const updated = await updateProjectVideoSource(project.id, next);
      onProjectUpdate?.(updated);
      const change = updated.videoSourceChange;
      setSuccess(
        [
          next === 'image'
            ? 'Kaynak tek resme çevrildi: seçilen görsel video boyunca ekranda kalır.'
            : 'Kaynak döngü videosuna çevrildi: videolar\\ altındaki klip döngüyle tekrarlanır.',
          ...change.warnings,
        ].join(' '),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Görsel kaynağı değiştirilemedi. Tekrar dene.');
    } finally {
      setIsSwitchingSource(false);
    }
  };

  const handleRefreshClips = async () => {
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setSuccess(`${mediaFolder}/ klasöründeki ${isStill ? 'görseller' : 'klipler'} yeniden okundu.`);
    } catch {
      setError('Klipler okunamadı. Klasörü kontrol edip tekrar dene.');
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
      setValidationError(`${fieldLabel} boş bırakılamaz.`);
    } else {
      const num = Number(val);
      if (!Number.isInteger(num) || num < 0) {
        setValidationError(`${fieldLabel} 0 ya da pozitif bir tam sayı olmalı.`);
      } else if (num > 2160) {
        setValidationError(`${fieldLabel} cannot exceed 2160px.`);
      } else {
        setValidationError(null);
        setter(num);
      }
    }
  };

  return (
    <StagePanel section="video" title="2. Video" status={assets.clip} stageStatus={stageStatus}>
      <div className="stage-media">
        <AssetPreview
          kind={isStill ? 'image' : 'video'}
          fileName={previewName}
          src={previewUrl}
          emptyLabel={
            clipMissing
              ? `Ayarlı klip bulunamadı: ${project.clip?.value}`
              : isStill
                ? 'Henüz görsel yok. resimler\\ klasörüne bir görsel yükleyin veya ekleyin.'
                : 'Klip seçilmedi. Döngü klibini (.mp4) videolar\\ klasörüne koy.'
          }
        />
        <div className="stage-actions">
          <fieldset
            style={{
              border: '1px solid var(--border, #333)', borderRadius: 6, padding: '8px 12px 10px', margin: '0 0 12px',
            }}
          >
            <legend style={{ fontSize: 12, padding: '0 6px' }}>Görsel kaynağı</legend>
            <div role="radiogroup" aria-label="Görsel kaynağı" style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
              {(['clip', 'image'] as VideoSource[]).map((source) => (
                <label key={source} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input
                    type="radio"
                    name={`video-source-${project.id}`}
                    value={source}
                    checked={(project.videoSource ?? 'clip') === source}
                    disabled={isSwitchingSource}
                    onChange={() => void handleSwitchSource(source)}
                  />
                  {source === 'clip' ? 'Döngü videosu (.mp4)' : 'Tek resim'}
                  <span className="count">
                    ({project.videoSourceCandidates?.[source]?.count ?? 0} aday)
                  </span>
                </label>
              ))}
            </div>
            <p className="field-hint" style={{ marginBottom: 0 }}>
              Sonradan değiştirilebilir · kırpma korunur
            </p>
          </fieldset>
          {isStill ? (
            <>
              <p className="field-hint">
                Tek resim modu: seçilen görsel videonun tamamı boyunca ekranda kalır. Klip üretmeye gerek yok.
              </p>
              <UploadButton
                label="Görsel yükle (.png, .jpg, .webp)"
                accept=".png,.jpg,.jpeg,.webp"
                multiple
                onFiles={async (files) => {
                  let latest = project;
                  for (const file of files) latest = await uploadProjectImage(project.id, file);
                  onProjectUpdate?.(latest);
                }}
              />
            </>
          ) : (
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
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '12px 0 8px' }}>
            <h3 style={{ margin: 0 }}>
              {isStill ? 'Klasördeki görseller' : 'Klasördeki klipler'} <span className="count">({clips.length})</span>
            </h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, minHeight: 26, padding: '2px 10px', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                onClick={handleOpenFolder}
              >
                📂 Klasörü Aç
              </button>
              <button
                type="button"
                className="button"
                style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
                onClick={handleRefreshClips}
              >
                🔄 Yenile
              </button>
            </div>
          </div>
          <p className="field-hint" style={{ margin: '0 0 10px' }}>
            {isStill
              ? <>MASTER ve açı görselleri (<code>Master1.jpg</code> …) şu klasörden:</>
              : <>Döngü videosu dosyalarını (<code>.mp4</code>) şu klasöre koy:</>}{' '}
            <code
              onClick={handleOpenFolder}
              title={`Explorer’da ${mediaFolder} klasörünü aç`}
              style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
            >
              {project.dir || project.name}\{mediaFolder}\
            </code>.
          </p>
          {clips.length > 0 ? (
            <div className="option-list" role="radiogroup" aria-label={isStill ? 'Görseller' : 'Video klipleri'}>
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
                    {isCurrent ? <StatusBadge status="selected" label="Kullanımda" /> : null}
                  </label>
                );
              })}
            </div>
          ) : (
            <EmptyState compact title={isStill ? 'resimler\\ klasöründe henüz MASTER görseli yok.' : 'videolar\\ klasöründe .mp4 klip yok.'} />
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

            {/* En-Boy Oranı Seçimi: 16:9 mu yoksa 9:16 mı? */}
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 13, fontWeight: 700, display: 'block', marginBottom: 8, color: 'var(--text-main)' }}>
                📐 Video Formatı (Otomatik Kadraj Garantisi)
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {/* 16:9 Parçası */}
                <div
                  onClick={() => !isSaving && setAspect('16:9')}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    cursor: isSaving ? 'not-allowed' : 'pointer',
                    background: aspect === '16:9' ? '#f5f0e4' : 'var(--bg-surface)',
                    border: `2px solid ${aspect === '16:9' ? '#a5916f' : 'var(--border-subtle)'}`,
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 13.5, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>🖥️</span> 16:9 (Yatay / Landscape)
                    </strong>
                    <input
                      type="radio"
                      name="video-aspect-choice"
                      checked={aspect === '16:9'}
                      onChange={() => setAspect('16:9')}
                      disabled={isSaving}
                    />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    YouTube standart video formatı. Videoyu merkezden otomatik 16:9 oranına tamamlar.
                  </span>
                </div>

                {/* 9:16 Parçası */}
                <div
                  onClick={() => !isSaving && setAspect('9:16')}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    cursor: isSaving ? 'not-allowed' : 'pointer',
                    background: aspect === '9:16' ? '#f5f0e4' : 'var(--bg-surface)',
                    border: `2px solid ${aspect === '9:16' ? '#a5916f' : 'var(--border-subtle)'}`,
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 13.5, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>📱</span> 9:16 (Dikey / Portrait)
                    </strong>
                    <input
                      type="radio"
                      name="video-aspect-choice"
                      checked={aspect === '9:16'}
                      onChange={() => setAspect('9:16')}
                      disabled={isSaving}
                    />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    YouTube Shorts, TikTok ve Reels formatı. Videoyu merkezden otomatik 9:16 dikey kadraja tamamlar.
                  </span>
                </div>
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
                ? 'Kaydediliyor...'
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
