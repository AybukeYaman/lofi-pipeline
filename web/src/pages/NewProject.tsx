import { useEffect, useState, type FormEvent } from 'react';

import {
  assignAlbumToProject,
  createProject,
  fetchLibrary,
  fetchMusicLibrary,
  fetchProjectMusic,
  fetchProjects,
  ApiError,
} from '../api';
import { PageHeader } from '../components/PageHeader';
import { showError, showSuccess } from '../toast';
import type { LoadState, ProjectMusicAudio, ProjectSummary, VideoSource } from '../types';

type FormErrors = Partial<Record<'name' | 'form', string>>;

const INVALID_NAME_CHARS = /[<>:"/\\|?* - ]/;

const VIDEO_SOURCE_OPTIONS: Array<{ id: VideoSource; name: string; description: string }> = [
  { id: 'clip', name: 'Video loop (.mp4)', description: 'Master frame is animated into a short looping clip.' },
  { id: 'image', name: 'Single image', description: 'One still image stays on screen for the whole video — no clip needed.' },
];

const PROJECT_DRAFT_KEY = 'lofi_new_project_draft';

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function NewProject({
  initialParentId,
  onCancel,
  onCreated,
}: {
  initialParentId?: string;
  onCancel: () => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [concept, setConcept] = useState('');
  const [parentId, setParentId] = useState<string>(() => {
    if (initialParentId) return initialParentId;
    const params = new URLSearchParams(window.location.search);
    return params.get('parent') || '';
  });
  const [videoSource, setVideoSource] = useState<VideoSource>('clip');
  const [aspect, setAspect] = useState<'16:9' | '9:16'>('16:9');
  const [errors, setErrors] = useState<FormErrors>({});
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [namesState, setNamesState] = useState<LoadState>('loading');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [restoredDraftTime, setRestoredDraftTime] = useState<string | null>(null);

  const [availableAlbums, setAvailableAlbums] = useState<Array<{ id: string; name: string; trackCount: number }>>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('');

  const [availableProjects, setAvailableProjects] = useState<ProjectSummary[]>([]);
  const [parentMusicTracks, setParentMusicTracks] = useState<ProjectMusicAudio[]>([]);
  const [loadingParentMusic, setLoadingParentMusic] = useState<boolean>(false);
  const [selectedTracks, setSelectedTracks] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROJECT_DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft) {
          if (draft.name) setName(draft.name);
          if (draft.concept) setConcept(draft.concept);
          if (draft.parentId && !initialParentId) setParentId(draft.parentId);
          if (draft.videoSource === 'clip' || draft.videoSource === 'image') setVideoSource(draft.videoSource);
          if (draft.aspect === '16:9' || draft.aspect === '9:16') setAspect(draft.aspect);
          if (draft.selectedAlbumId) setSelectedAlbumId(draft.selectedAlbumId);
          setRestoredDraftTime(draft.savedAt || 'Önceki oturum');
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (initialParentId) {
      setParentId(initialParentId);
    } else {
      const params = new URLSearchParams(window.location.search);
      const urlParent = params.get('parent');
      if (urlParent) {
        setParentId(urlParent);
      }
    }
  }, [initialParentId]);

  // Üst proje seçildiğinde onun müziklerini çek
  useEffect(() => {
    if (!parentId) {
      setParentMusicTracks([]);
      setSelectedTracks([]);
      return;
    }
    let isActive = true;
    setLoadingParentMusic(true);
    fetchProjectMusic(parentId)
      .then((musicInfo) => {
        if (!isActive) return;
        const tracks = musicInfo.audioFiles || [];
        setParentMusicTracks(tracks);
        // Varsayılan olarak tüm parçaları seçili getir
        setSelectedTracks(tracks.map((t) => t.file));
        setLoadingParentMusic(false);
      })
      .catch(() => {
        if (!isActive) return;
        setParentMusicTracks([]);
        setSelectedTracks([]);
        setLoadingParentMusic(false);
      });

    return () => {
      isActive = false;
    };
  }, [parentId]);

  useEffect(() => {
    let isActive = true;
    fetchProjects()
      .then((projects) => {
        if (!isActive) return;
        setAvailableProjects(projects);
        setExistingNames(projects.map((project) => project.name.toLowerCase()));
        setNamesState('loaded');
      })
      .catch(() => {
        if (isActive) setNamesState('error');
      });

    fetchMusicLibrary()
      .then((musicLib) => {
        if (!isActive) return;
        if (Array.isArray(musicLib.albums)) {
          setAvailableAlbums(musicLib.albums.map((a) => ({ id: a.id, name: a.name, trackCount: a.trackCount })));
        }
      })
      .catch(() => {});

    return () => {
      isActive = false;
    };
  }, []);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setErrors((prev) => ({ ...prev, form: undefined }));
    setServerProblems([]);
  };

  const saveDraft = () => {
    try {
      if (name || concept || selectedAlbumId || parentId) {
        localStorage.setItem(
          PROJECT_DRAFT_KEY,
          JSON.stringify({
            name,
            concept,
            parentId,
            videoSource,
            aspect,
            selectedAlbumId,
            savedAt: new Date().toLocaleTimeString(),
          }),
        );
      }
    } catch {}
  };

  const clearDraft = () => {
    try {
      localStorage.removeItem(PROJECT_DRAFT_KEY);
    } catch {}
    setRestoredDraftTime(null);
    setName('');
    setConcept('');
    setParentId('');
    setParentMusicTracks([]);
    setSelectedTracks([]);
    setVideoSource('clip');
    setAspect('16:9');
    setSelectedAlbumId('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate({ name, existingNames });
    setErrors(nextErrors);
    setServerProblems([]);

    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const response = await createProject({
        name: name.trim(),
        videoSource,
        aspect,
        concept: concept.trim() || undefined,
        parentId: parentId || undefined,
        selectedTracks: parentId && selectedTracks.length > 0 ? selectedTracks : undefined,
      });

      try {
        localStorage.removeItem(PROJECT_DRAFT_KEY);
      } catch {}

      if (selectedAlbumId) {
        await assignAlbumToProject({ albumId: selectedAlbumId, projectId: response.project.id }).catch(() => {});
      }

      showSuccess(`"${response.project.name || name}" projesi başarıyla oluşturuldu!`, 'Proje Başlatıldı');

      if (onCreated) {
        onCreated(response.project.id);
      }
    } catch (err: unknown) {
      showError(err, 'Proje oluşturulamadı.');
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrors({ name: err.message });
        } else if (err.status === 422) {
          setErrors({ form: err.message });
          if (err.problems && err.problems.length > 0) {
            setServerProblems(err.problems);
          }
        } else {
          setErrors({ form: err.message });
        }
      } else {
        setErrors({ form: err instanceof Error ? err.message : 'Project could not be created.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelWithDraft = () => {
    saveDraft();
    onCancel();
  };

  const handleDiscard = () => {
    clearDraft();
    onCancel();
  };


  return (
    <section className="page narrow">
      <PageHeader
        eyebrow="NEW PROJECT"
        title="New Project"
        description="Set up the album and visual for a new video."
      />

      {restoredDraftTime ? (
        <div
          className="notice"
          style={{
            borderColor: '#e5dccb',
            background: '#faf7f0',
            color: '#5c523b',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 20,
          }}
        >
          <div>
            <strong>📝 Yarım kalan proje taslağı yüklendi</strong> <span className="muted">({restoredDraftTime})</span>
          </div>
          <button
            type="button"
            className="button"
            style={{ fontSize: 12, padding: '2px 8px' }}
            onClick={clearDraft}
          >
            🗑️ Taslağı Sıfırla
          </button>
        </div>
      ) : null}

      <form className="panel form" onSubmit={handleSubmit} noValidate>
        {errors.form ? (
          <div className="state-card" role="alert" style={{ borderColor: '#b5654f', color: '#97432c' }}>
            <strong>{errors.form}</strong>
            {serverProblems.length > 0 ? (
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {serverProblems.map((prob, idx) => (
                  <li key={idx}>{prob}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => edit(setName)(event.target.value)}
            aria-invalid={Boolean(errors.name)}
            aria-describedby="project-name-hint"
            autoComplete="off"
            placeholder="video10-rainy-tokyo"
            disabled={isSubmitting}
          />
          <p id="project-name-hint" className={errors.name ? 'field-error' : 'field-hint'}>
            {errors.name ??
              (namesState === 'loading'
                ? 'Checking existing project names...'
                : namesState === 'error'
                  ? 'Existing names could not be checked.'
                  : 'Used as the folder name under videolar\\.')}
          </p>
        </div>

        <div className="field">
          <label htmlFor="project-parent">
            📁 Üst Proje (Alt Proje Oluşturmak İçin Opsiyonel)
          </label>
          <select
            id="project-parent"
            value={parentId}
            onChange={(event) => edit(setParentId)(event.target.value)}
            disabled={isSubmitting}
          >
            <option value="">(Yok — Bağımsız Ana Proje)</option>
            {availableProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.parentId ? `  ↳ ${p.name} (Alt: ${p.parentId})` : `📁 ${p.name}`}
              </option>
            ))}
          </select>
          <p className="field-hint">
            Bir ana proje seçerseniz bu proje onun alt projesi olur ve ana projenin müziklerini aşağıdan seçebilirsiniz.
          </p>
        </div>

        {parentId ? (
          <div
            className="field"
            style={{
              background: '#fdfbf7',
              border: '1px solid #e2dac9',
              borderRadius: 8,
              padding: 14,
              marginBottom: 16,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 10,
                flexWrap: 'wrap',
                gap: 8,
              }}
            >
              <div>
                <strong style={{ fontSize: 14, color: '#333' }}>🎵 Ana Projeden Müzik Seç</strong>
                <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>
                  ({selectedTracks.length} / {parentMusicTracks.length} seçildi)
                </span>
              </div>
              {parentMusicTracks.length > 0 ? (
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12, padding: '3px 8px' }}
                    onClick={() => setSelectedTracks(parentMusicTracks.map((t) => t.file))}
                  >
                    ✓ Tümünü Seç
                  </button>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12, padding: '3px 8px' }}
                    onClick={() => setSelectedTracks([])}
                  >
                    ✕ Temizle
                  </button>
                </div>
              ) : null}
            </div>

            {loadingParentMusic ? (
              <div style={{ padding: '12px 0', color: '#888', fontSize: 13 }}>
                Ana projenin müzikleri yükleniyor...
              </div>
            ) : parentMusicTracks.length === 0 ? (
              <div style={{ padding: '8px 0', color: '#8c7d6b', fontSize: 13 }}>
                "{parentId}" projesinin <code>audio/</code> klasöründe henüz ses dosyası yok.
              </div>
            ) : (
              <div
                style={{
                  maxHeight: 220,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  paddingRight: 4,
                }}
              >
                {parentMusicTracks.map((track) => {
                  const isChecked = selectedTracks.includes(track.file);
                  return (
                    <label
                      key={track.file}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: 6,
                        background: isChecked ? '#f3eee3' : '#ffffff',
                        border: `1px solid ${isChecked ? '#bfae91' : '#e5ddcc'}`,
                        cursor: 'pointer',
                        fontSize: 13,
                        gap: 10,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedTracks((prev) => [...prev, track.file]);
                            } else {
                              setSelectedTracks((prev) => prev.filter((f) => f !== track.file));
                            }
                          }}
                        />
                        <span
                          style={{
                            fontWeight: 500,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {track.file}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {track.duration ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            {formatDuration(track.duration)}
                          </span>
                        ) : null}
                        {track.previewUrl ? (
                          <audio
                            controls
                            src={track.previewUrl}
                            preload="none"
                            style={{ height: 26, width: 150 }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <p className="field-hint" style={{ marginTop: 8, marginBottom: 0 }}>
              Seçtiğiniz müzikler bu alt projenin <code>audio/</code> klasörüne kopyalanacaktır.
            </p>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="project-concept">Concept / Album</label>
          <textarea
            id="project-concept"
            value={concept}
            onChange={(event) => edit(setConcept)(event.target.value)}
            rows={3}
            placeholder="Late night rain over a quiet Tokyo apartment"
            disabled={isSubmitting}
          />
          <p className="field-hint">Optional.</p>
        </div>

        <fieldset className="field">
          <legend>Video visual</legend>
          <div className="option-list option-card-list" role="radiogroup">
            {VIDEO_SOURCE_OPTIONS.map((option) => {
              const isSelected = videoSource === option.id;
              return (
                <label key={option.id} className={isSelected ? 'option option-card selected' : 'option option-card'}>
                  <input
                    type="radio"
                    name="video-source"
                    value={option.id}
                    checked={isSelected}
                    onChange={() => edit(setVideoSource)(option.id)}
                    disabled={isSubmitting}
                  />
                  <span className="option-card-text">
                    <span className="option-card-title">{option.name}</span>
                    <span className="option-card-description">{option.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="field">
          <legend>📐 Video Boyut Formatı (Aspect Ratio)</legend>
          <div className="option-list option-card-list" role="radiogroup">
            <label className={aspect === '16:9' ? 'option option-card selected' : 'option option-card'}>
              <input
                type="radio"
                name="video-aspect"
                value="16:9"
                checked={aspect === '16:9'}
                onChange={() => edit(setAspect)('16:9')}
                disabled={isSubmitting}
              />
              <span className="option-card-text">
                <span className="option-card-title">🖥️ 16:9 Yatay (Landscape)</span>
                <span className="option-card-description">YouTube Standart / TV Ekran (1920×1080)</span>
              </span>
            </label>
            <label className={aspect === '9:16' ? 'option option-card selected' : 'option option-card'}>
              <input
                type="radio"
                name="video-aspect"
                value="9:16"
                checked={aspect === '9:16'}
                onChange={() => edit(setAspect)('9:16')}
                disabled={isSubmitting}
              />
              <span className="option-card-text">
                <span className="option-card-title">📱 9:16 Dikey (Portrait)</span>
                <span className="option-card-description">YouTube Shorts, Reels, TikTok (1080×1920)</span>
              </span>
            </label>
          </div>
        </fieldset>

        {availableAlbums.length > 0 ? (
          <div className="field">
            <label htmlFor="music-album-select">
              🎵 Müzik Albümü (Opsiyonel — Kütüphaneden Doğrudan Bağla)
            </label>
            <select
              id="music-album-select"
              value={selectedAlbumId}
              onChange={(e) => setSelectedAlbumId(e.target.value)}
              disabled={isSubmitting}
            >
              <option value="">(Yok — Müzik planı veya manuel ses eklenecek)</option>
              {availableAlbums.map((album) => (
                <option key={album.id} value={album.id}>
                  📁 {album.name} ({album.trackCount} parça)
                </option>
              ))}
            </select>
            <p className="field-hint">
              Seçilen albümdeki tüm ses dosyaları otomatik olarak bu projenin <code>audio/</code> klasörüne kopyalanacaktır.
            </p>
          </div>
        ) : null}

        <div className="form-actions" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="button" type="button" onClick={handleCancelWithDraft} disabled={isSubmitting}>
            💾 Taslağı Sakla & Kapat
          </button>
          <button
            className="button"
            type="button"
            style={{ color: '#a63a2b' }}
            onClick={handleDiscard}
            disabled={isSubmitting}
          >
            ✕ Vazgeç
          </button>
          <button className="button button-primary" type="submit" disabled={isSubmitting} style={{ marginLeft: 'auto' }}>
            {isSubmitting ? 'Creating Project...' : 'Create Project'}
          </button>
        </div>
      </form>
    </section>
  );
}

function validate({
  name,
  existingNames,
}: {
  name: string;
  existingNames: string[];
}): FormErrors {
  const errors: FormErrors = {};
  const trimmed = name.trim();

  if (!trimmed) {
    errors.name = 'Project name is required.';
  } else if (trimmed.length > 80) {
    errors.name = 'Use 80 characters or fewer.';
  } else if (
    INVALID_NAME_CHARS.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.endsWith('.')
  ) {
    errors.name = 'Use a valid folder name (no < > : " / \\ | ? * and no trailing dot).';
  } else if (existingNames.includes(trimmed.toLowerCase())) {
    errors.name = 'A project with this name already exists.';
  }

  return errors;
}

