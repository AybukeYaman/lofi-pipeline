/** 2. adım — Video: döngü klibi / tek görsel seçimi, kırpma ve format. */
import { useEffect, useState } from 'react';
import {
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
import { StatusTabs } from '../../components/StatusTabs';
import { EmptyState } from '../../components/Feedback';
import { StatusBadge } from '../../components/StatusBadge';
import type { ProjectDetail, VideoSource } from '../../types';
import { fileName } from './assetState';
import { UploadButton } from './StepWidgets';
import { StagePanel, type StageProps } from './StagePanel';

export function VideoStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  // Tek resim modu: clips = resimler\ altındaki bütün görseller (sunucu ada göre sıralar).
  const isStill = project.videoSource === 'image';
  // Pomodoro açıksa görüntüler durum sekmeleriyle seçilir (StatusTabs).
  const isPomodoro = project.readiness?.pomodoro?.enabled === true;
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
        setValidationError(`${fieldLabel} en fazla 2160px olabilir.`);
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
          <fieldset className="source-switch">
            <legend>Görsel kaynağı</legend>
            <div role="radiogroup" aria-label="Görsel kaynağı" className="source-switch-options">
              {(['clip', 'image'] as VideoSource[]).map((source) => (
                <label key={source} className="source-switch-option">
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
            <p className="field-hint">Sonradan değiştirilebilir · kırpma korunur</p>
          </fieldset>
          {isStill ? (
            <>
              <p className="field-hint">
                Tek resim modu: seçilen görsel videonun tamamı boyunca ekranda kalır. Klip üretmeye gerek yok.
              </p>
              <UploadButton
                label="Görsel yükle (.png, .jpg, .webp)"
                accept=".png,.jpg,.jpeg,.webp"
                primary={!canSave && stageStatus !== 'done'}
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
              primary={!canSave && stageStatus !== 'done'}
              multiple
              onFiles={async (files) => {
                let latest = project;
                for (const file of files) latest = await uploadProjectClip(project.id, file);
                onProjectUpdate?.(latest);
              }}
            />
          )}
          <div className="stage-section-head">
            <h3>
              {isPomodoro ? 'Ana görüntü' : isStill ? 'Klasördeki görseller' : 'Klasördeki klipler'} <span className="count">({clips.length})</span>
            </h3>
            <div className="tool-box-row">
              <button type="button" className="button button-compact" onClick={handleOpenFolder}>
                Klasörü aç
              </button>
            </div>
          </div>
          {/* Uzun klasör yolu yok: "Klasörü aç" düğmesi aynı yolu açıyor (tam yol "Dosya yolları"nda).
              Pomodoro'da aynı cümleyi StatusTabs söylüyor. */}
          {isPomodoro ? null : (
            <p className="field-hint">
              {isStill
                ? <>MASTER ve açı görselleri (<code>Master1.jpg</code> …) <code>{mediaFolder}\</code> klasöründen seçilir.</>
                : <>Döngü videosu (<code>.mp4</code>) dosyalarını <code>{mediaFolder}\</code> klasörüne koy ya da yukarıdan yükle.</>}
            </p>
          )}
          {isPomodoro ? (
            // Pomodoro: liste yerine ana görüntü + "hangi görüntü ne zaman" sekmeleri (küçük resimli).
            <StatusTabs
              project={project}
              workPath={selected}
              workCandidates={clips}
              onPickWork={(path) => { setSelected(path); setError(null); setSuccess(null); }}
              onProjectUpdate={onProjectUpdate}
            />
          ) : clips.length > 0 ? (
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

          {/* Kırpma ve format ayarlarının çoğu projede varsayılanla çalışır:
              varsayılan dışı bir değer varsa açık, yoksa katlı başlar. */}
          <details className="advanced" open={watermark || aspect !== '16:9'}>
            <summary>Kenar kırpma ve video formatı (gelişmiş)</summary>
            <div className="advanced-body">
              <div className="stage-section-head">
                <h3>Watermark ve kenar kırpma</h3>
                <div className="tool-box-row">
                  <button type="button" className="button button-compact" onClick={() => handleApplyPreset(150, 0, 0, 0)}>
                    Hailuo (alt 150px)
                  </button>
                  <button type="button" className="button button-compact" onClick={() => handleApplyPreset(0, 0, 0, 0)}>
                    Sıfırla
                  </button>
                </div>
              </div>

              <label className="option">
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
                <span>Kenar / watermark kırpmayı etkinleştir</span>
              </label>

              <div className={watermark ? 'crop-grid' : 'crop-grid is-off'}>
                {([
                  ['Üstten kırp (px)', cropTopInput, setCropTop, setCropTopInput, 'Üst kırpma'],
                  ['Alttan kırp (px)', cropBottomInput, setCropBottom, setCropBottomInput, 'Alt kırpma'],
                  ['Soldan kırp (px)', cropLeftInput, setCropLeft, setCropLeftInput, 'Sol kırpma'],
                  ['Sağdan kırp (px)', cropRightInput, setCropRight, setCropRightInput, 'Sağ kırpma'],
                ] as const).map(([label, value, setter, inputSetter, fieldLabel]) => (
                  <div className="field" key={label}>
                    <label>{label}</label>
                    <input
                      type="number"
                      min={0}
                      max={2160}
                      value={value}
                      disabled={!watermark || isSaving}
                      onChange={(e) => handleNumberChange(e.target.value, setter, inputSetter, fieldLabel)}
                    />
                  </div>
                ))}
              </div>

              <h3>Video formatı</h3>
              <div className="choice-cards" role="radiogroup" aria-label="Video formatı">
                {([
                  ['16:9', '16:9 (yatay)', 'YouTube standart video formatı. Videoyu merkezden otomatik 16:9 oranına tamamlar.'],
                  ['9:16', '9:16 (dikey)', 'YouTube Shorts, TikTok ve Reels formatı. Videoyu merkezden otomatik 9:16 dikey kadraja tamamlar.'],
                ] as const).map(([value, title, text]) => (
                  <label key={value} className={aspect === value ? 'choice-card selected' : 'choice-card'}>
                    <span className="choice-card-head">
                      <strong>{title}</strong>
                      <input
                        type="radio"
                        name="video-aspect-choice"
                        checked={aspect === value}
                        onChange={() => setAspect(value)}
                        disabled={isSaving}
                      />
                    </span>
                    <span className="muted">{text}</span>
                  </label>
                ))}
              </div>
            </div>
          </details>

          {validationError ? (
            <p className="field-hint field-error" role="alert">
              {validationError}
            </p>
          ) : null}

          {error ? (
            <p className="field-hint field-error" role="alert">
              {error}
            </p>
          ) : null}

          {success ? <p className="field-hint field-success">✓ {success}</p> : null}

          <div>
            <button
              className={canSave ? 'button button-primary' : 'button'}
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
