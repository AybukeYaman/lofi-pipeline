import { useEffect, useState, type ReactNode } from 'react';

import {
  completeProjectMusic,
  fetchBuildStatus,
  fetchProject,
  fetchProjectMaster,
  getProjectClipUrl,
  getProjectMasterUrl,
  getProjectOutputUrl,
  getProjectReferenceUrl,
  selectProjectClip,
  startBuild,
  updateProjectCrop,
  ApiError,
} from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState, NotConnectedNotice } from '../../components/Feedback';
import { ReferencePicker, type ReferenceDraft } from '../../components/ReferencePicker';
import { StatusBadge, type AssetStatus } from '../../components/StatusBadge';
import { TrackList } from '../../components/TrackList';
import type { BuildJob, MasterFrameInfo, ProjectDetail } from '../../types';
import type { WorkflowStatus } from '../../workflow';
import { fileName, musicTracks, styleName, type ProjectAssets } from './assetState';

export type StageProps = {
  project: ProjectDetail;
  assets: ProjectAssets;
  stageStatus: WorkflowStatus;
  onProjectUpdate?: (updatedProject: ProjectDetail) => void;
};

const NOT_CONNECTED_HINT = 'Not connected yet';

export function sectionAnchor(section: string) {
  return `stage-${section}`;
}

type StagePanelProps = {
  section: string;
  title: string;
  status: AssetStatus;
  stageStatus: WorkflowStatus;
  children: ReactNode;
};

function StagePanel({ section, title, status, stageStatus, children }: StagePanelProps) {
  return (
    <section
      className={`panel stage-panel${stageStatus === 'current' ? ' is-current' : ''}`}
      id={sectionAnchor(section)}
      aria-labelledby={`${sectionAnchor(section)}-title`}
    >
      <header className="stage-header">
        <h2 id={`${sectionAnchor(section)}-title`}>{title}</h2>
        <div className="stage-meta">
          {stageStatus === 'current' ? <span className="stage-current">Current step</span> : null}
          <StatusBadge status={status} />
        </div>
      </header>
      {children}
    </section>
  );
}

function ReferenceThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      style={{
        width: 32,
        height: 32,
        borderRadius: 4,
        objectFit: 'cover',
        border: '1px solid #ddd6cc',
        flexShrink: 0,
      }}
    />
  );
}

export function StyleStage({ project, assets, stageStatus }: StageProps) {
  const [drafts, setDrafts] = useState<ReferenceDraft[]>([]);
  const style = styleName(project);
  const references = project.references ?? [];

  return (
    <StagePanel section="style" title="Style / References" status={assets.style} stageStatus={stageStatus}>
      <div className="stage-grid">
        <div className="stage-block">
          <h3>Current style</h3>
          {style ? (
            <div className="style-summary">
              <div className="swatch swatch-neutral" aria-hidden="true" />
              <div>
                <strong>{style}</strong>
                <p className="muted">
                  Style block: {project.styleBlockExists ? 'available' : 'not generated'}
                </p>
              </div>
            </div>
          ) : (
            <EmptyState compact title="No style selected." />
          )}
        </div>

        <div className="stage-block">
          <h3>
            References <span className="count">{references.length}</span>
            <StatusBadge status={assets.references} />
          </h3>
          {references.length > 0 ? (
            <ul className="file-list">
              {references.map((path) => {
                const name = fileName(path);
                const refUrl = name ? getProjectReferenceUrl(project.id, name) : null;
                return (
                  <li key={path} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {refUrl ? <ReferenceThumbnail src={refUrl} alt={name || ''} /> : null}
                    <span>{name}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact title="No reference images in the project folder." />
          )}
          <ReferencePicker items={drafts} onChange={setDrafts} emptyLabel="No new references staged." />
        </div>
      </div>
    </StagePanel>
  );
}

export function MasterStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const masterName = fileName(project.master);
  const masterUrl = masterName ? getProjectMasterUrl(project.id, masterName) : null;
  const isMasterReady = project.readiness?.master?.ready ?? Boolean(project.master);

  const [masterInfo, setMasterInfo] = useState<MasterFrameInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const handleCopyPrompt = async () => {
    if (!masterInfo?.prompt) return;
    try {
      await navigator.clipboard.writeText(masterInfo.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy prompt to clipboard.');
    }
  };

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
          ? 'Master frame detected and loaded.'
          : 'Project refreshed. Save image as resimler\\MASTER.png when ready.',
      );
    } catch {
      setError('Could not refresh project state.');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <StagePanel section="master" title="Master Frame (Faz 1)" status={assets.master} stageStatus={stageStatus}>
      <div className="stage-media">
        <AssetPreview
          kind="image"
          fileName={masterName}
          src={masterUrl}
          emptyLabel="No master frame yet. Generate with the Faz 1 prompt and save as resimler\MASTER.png."
        />
        <div className="stage-actions">
          <h3>Master Frame Workflow</h3>
          <p className="field-hint">
            The master visual frame establishes the visual atmosphere and scene composition. In the pipeline design, it is created externally via the Faz 1 prompt (Midjourney, Nano Banana, etc.) and placed in <code>resimler\MASTER.png</code>.
          </p>

          {masterInfo?.prompt ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <label style={{ fontSize: 13, fontWeight: 600 }}>Faz 1 Prompt</label>
                <button
                  className="button"
                  type="button"
                  style={{ fontSize: 12, minHeight: 28, padding: '0 10px' }}
                  onClick={handleCopyPrompt}
                >
                  {copied ? '✓ Copied!' : 'Copy Prompt'}
                </button>
              </div>
              <textarea
                readOnly
                rows={4}
                value={masterInfo.prompt}
                style={{
                  width: '100%',
                  fontSize: 12,
                  fontFamily: 'monospace',
                  background: '#fcfbf9',
                  borderColor: '#ddd6cc',
                  resize: 'vertical',
                }}
              />
            </div>
          ) : masterInfo?.promptError ? (
            <p className="field-hint field-error" role="alert">
              {masterInfo.promptError}
            </p>
          ) : null}

          <div style={{ marginTop: 8 }}>
            <p className="field-hint">
              <strong>Target location:</strong> <code>{masterInfo?.folder ?? `${project.dir || project.name}\\resimler`}\MASTER.png</code>
              <br />
              <span className="muted">Supported formats: .png, .jpg, .jpeg, .webp</span>
            </p>
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

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
            <button
              className="button button-primary"
              type="button"
              disabled={isRefreshing}
              onClick={handleRefresh}
            >
              {isRefreshing ? 'Checking resimler\\...' : 'Check & Refresh Master Frame'}
            </button>
          </div>
        </div>
      </div>
    </StagePanel>
  );
}

export function VideoStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const clips = project.clips ?? [];
  const currentClip = project.clip?.exists ? project.clip.path : null;
  const currentClipName = fileName(currentClip);
  const clipMissing = Boolean(project.clip?.value) && !project.clip?.exists;

  const backendVideo = project.projectJson?.data?.video;
  const backendCrop = backendVideo?.cropBottom ?? 150;
  const backendWatermark = backendVideo?.watermark ?? (backendCrop > 0);

  const [selected, setSelected] = useState<string | null>(currentClip ?? null);
  const [cropBottom, setCropBottom] = useState<number>(backendCrop);
  const [cropInput, setCropInput] = useState<string>(String(backendCrop));
  const [watermark, setWatermark] = useState<boolean>(backendWatermark);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Synchronize state when project updates from backend
  useEffect(() => {
    const freshCrop = project.projectJson?.data?.video?.cropBottom ?? 150;
    const freshWatermark = project.projectJson?.data?.video?.watermark ?? (freshCrop > 0);
    setCropBottom(freshCrop);
    setCropInput(String(freshCrop));
    setWatermark(freshWatermark);
    setSelected(project.clip?.exists ? project.clip.path ?? null : null);
  }, [project.clip?.exists, project.clip?.path, project.projectJson?.data?.video]);

  const chosenPath = selected || currentClip;
  const chosenName = fileName(chosenPath);
  const hasClipChange = selected !== currentClip;
  const hasSettingsChange = cropBottom !== backendCrop || watermark !== backendWatermark;
  const canSave = Boolean(chosenName) && (hasClipChange || hasSettingsChange) && !validationError && !isSaving;

  // Determine active preview: load URL for currently selected candidate or saved clip
  const previewName = chosenName ?? currentClipName;
  const previewUrl = previewName ? getProjectClipUrl(project.id, previewName) : null;

  const handleSave = async () => {
    if (!chosenName || isSaving || validationError) return;

    setIsSaving(true);
    setError(null);
    setSuccess(null);

    const effectiveCrop = watermark ? (cropBottom > 0 ? cropBottom : 150) : 0;

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
            watermark,
            cropBottom: effectiveCrop,
          });
        } catch (cropErr: unknown) {
          // If backend only supports combined or legacy endpoint, fallback to local state merge
          if (cropErr instanceof ApiError && cropErr.status === 404) {
            updatedProject = {
              ...updatedProject,
              projectJson: {
                ...updatedProject.projectJson,
                data: {
                  ...updatedProject.projectJson?.data,
                  video: {
                    ...updatedProject.projectJson?.data?.video,
                    cropBottom: effectiveCrop,
                    watermark,
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
      setSuccess('Video settings and clip saved successfully.');
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

  return (
    <StagePanel section="video" title="Video Clip" status={assets.clip} stageStatus={stageStatus}>
      <div className="stage-media">
        <AssetPreview
          kind="video"
          fileName={previewName}
          src={previewUrl}
          emptyLabel={
            clipMissing
              ? `Configured clip not found: ${project.clip?.value}`
              : 'No clip selected. Put the loop clip (.mp4) under videolar\\.'
          }
        />
        <div className="stage-actions">
          <h3>
            Clips in folder <span className="count">{clips.length}</span>
          </h3>
          {clips.length > 0 ? (
            <div className="option-list" role="radiogroup" aria-label="Video clips">
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
            <EmptyState compact title="No .mp4 clips in videolar\." />
          )}

          <div style={{ marginTop: 14, width: '100%', borderTop: '1px solid #ece5dc', paddingTop: 14 }}>
            <h3 style={{ marginBottom: 8 }}>Clip Settings</h3>

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
                  if (checked && cropBottom === 0) {
                    setCropBottom(150);
                    setCropInput('150');
                    setValidationError(null);
                  } else if (!checked) {
                    setCropBottom(0);
                    setCropInput('0');
                    setValidationError(null);
                  }
                }}
              />
              <span>Crop bottom (watermark removal)</span>
            </label>

            <div className="field">
              <label htmlFor={`crop-bottom-${project.id}`}>
                Bottom crop (pixels)
              </label>
              <input
                id={`crop-bottom-${project.id}`}
                type="number"
                min={0}
                max={2160}
                value={cropInput}
                disabled={!watermark || isSaving}
                onChange={(e) => {
                  const val = e.target.value;
                  setCropInput(val);
                  setError(null);
                  setSuccess(null);
                  if (val.trim() === '') {
                    setValidationError('Bottom crop is required.');
                  } else {
                    const num = Number(val);
                    if (!Number.isInteger(num) || num < 0) {
                      setValidationError('Bottom crop must be 0 or a positive integer.');
                    } else if (num > 2160) {
                      setValidationError('Bottom crop cannot exceed 2160px.');
                    } else {
                      setValidationError(null);
                      setCropBottom(num);
                    }
                  }
                }}
              />
              <p className="field-hint">
                Default 150px removes Hailuo AI watermark from bottom edge.
              </p>
            </div>
          </div>

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

          {success ? (
            <p className="field-hint" style={{ color: '#34603f' }}>
              ✓ {success}
            </p>
          ) : null}

          <button
            className="button"
            type="button"
            disabled={!canSave || isSaving}
            onClick={handleSave}
          >
            {isSaving
              ? 'Saving...'
              : hasClipChange
                ? currentClip
                  ? 'Replace clip & save settings'
                  : 'Use selected clip & save'
                : 'Save video settings'}
          </button>
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

  const isMusicReady = readinessMusic?.ready ?? (assets.music === 'ready');
  const missingTracksCount = Math.max(0, trackCount - audioCount);

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

  return (
    <StagePanel section="music" title="Music" status={assets.music} stageStatus={stageStatus}>
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
            · {audioCount} audio files in folder
            {trackCount > 0 && missingTracksCount > 0 ? ` · ${missingTracksCount} remaining` : null}
            {completedCount > 0 ? ` · ${completedCount} marked completed` : null}
            {readinessMusic?.status ? ` · Status: ${readinessMusic.status}` : null}
          </span>
        </p>
      </div>

      {tracks.length > 0 ? (
        <TrackList tracks={tracks} />
      ) : audioCount > 0 ? (
        <EmptyState compact title="Track names are not available.">
          {audioCount} audio files found in {project.audioDir ?? 'the audio folder'}.
        </EmptyState>
      ) : (
        <EmptyState compact title="No music tracks yet.">
          Put Suno audio files (.mp3, .wav, .m4a, .flac) in <code>{project.audioDir ?? 'the audio folder'}</code>.
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
          Refresh Audio Files
        </button>
      </div>

      {!isMusicReady && audioCount === 0 ? (
        <p className="field-hint" style={{ marginTop: 6 }}>
          At least 1 audio file is required in the audio directory to complete the music step.
        </p>
      ) : null}
    </StagePanel>
  );
}

export function BuildStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const [buildJob, setBuildJob] = useState<BuildJob | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

  const readinessBuild = project.readiness?.build;
  const canBuild = readinessBuild ? readinessBuild.ready : project.step?.id === 'build';
  const missingRequirements = readinessBuild?.missing ?? [];
  const rows: { label: string; status: AssetStatus }[] = [
    { label: 'Audio', status: assets.music },
    { label: 'Ambient', status: assets.ambient },
    { label: 'Video Clip', status: assets.clip },
    { label: 'Assembly', status: assets.assembly },
    { label: 'Output', status: assets.output },
  ];

  // Initial fetch of build status
  useEffect(() => {
    let isActive = true;
    fetchBuildStatus(project.id)
      .then((job) => {
        if (!isActive) return;
        setBuildJob(job);
      })
      .catch(() => {
        // ignore
      });
    return () => {
      isActive = false;
    };
  }, [project.id]);

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

  const videoConfig = project.projectJson?.data?.video;
  const configuredCrop = videoConfig?.cropBottom ?? 150;
  const isWatermarkActive = videoConfig?.watermark ?? (configuredCrop > 0);

  return (
    <StagePanel section="build" title="Build" status={assets.assembly} stageStatus={stageStatus}>
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
          <dt>Video Crop</dt>
          <dd>
            {isWatermarkActive && configuredCrop > 0
              ? `${configuredCrop}px (watermark removal)`
              : 'No crop'}
          </dd>
        </div>
      </dl>

      {missingRequirements.length > 0 ? (
        <p className="field-hint field-error" style={{ marginTop: 12 }}>
          Missing requirements: {missingRequirements.join(', ')}
        </p>
      ) : null}

      {buildError ? (
        <p className="field-hint field-error" role="alert" style={{ marginTop: 12 }}>
          {buildError}
        </p>
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
            <p className="field-hint field-error" style={{ marginTop: 4 }}>
              {buildJob.error}
            </p>
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
            ? 'Building Video...'
            : isStarting
              ? 'Starting...'
              : project.output?.exists
                ? 'Rebuild Video'
                : 'Build Video'}
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

export function OutputStage({ project, assets, stageStatus }: StageProps) {
  const outputName = fileName(project.output?.path);
  const outputUrl = project.output?.exists && outputName ? getProjectOutputUrl(project.id, outputName) : null;

  return (
    <StagePanel section="completed" title="Completed / Output" status={assets.output} stageStatus={stageStatus}>
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
          </div>
        </div>
      ) : (
        <EmptyState compact title="No output yet.">
          The video will be assembled and written to <code>{outputName ?? 'out/final_ambient.mp4'}</code> when build completes.
        </EmptyState>
      )}
    </StagePanel>
  );
}

