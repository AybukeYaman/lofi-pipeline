import { useEffect, useState, type FormEvent } from 'react';

import { assignAlbumToProject, createProject, fetchLibrary, fetchMusicLibrary, fetchProjects, ApiError } from '../api';
import { PageHeader } from '../components/PageHeader';
import { sampleStyles } from '../mockData';
import { showError, showSuccess } from '../toast';
import type { LoadState, VideoSource } from '../types';

type FormErrors = Partial<Record<'name' | 'style' | 'form', string>>;

const INVALID_NAME_CHARS = /[<>:"/\\|?* - ]/;

type StyleOption = { id: string; name: string; description: string };

const VIDEO_SOURCE_OPTIONS: Array<{ id: VideoSource; name: string; description: string }> = [
  { id: 'clip', name: 'Video loop (.mp4)', description: 'Master frame is animated into a short looping clip.' },
  { id: 'image', name: 'Single image', description: 'One still image stays on screen for the whole video — no clip needed.' },
];

const PROJECT_DRAFT_KEY = 'lofi_new_project_draft';

export function NewProject({
  initialStyle,
  onCancel,
  onCreated,
}: {
  initialStyle?: string;
  onCancel: () => void;
  onCreated?: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [concept, setConcept] = useState('');
  const [style, setStyle] = useState(() => {
    if (initialStyle) return initialStyle;
    const params = new URLSearchParams(window.location.search);
    return params.get('style') || '';
  });
  const [videoSource, setVideoSource] = useState<VideoSource>('clip');
  const [errors, setErrors] = useState<FormErrors>({});
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [namesState, setNamesState] = useState<LoadState>('loading');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [restoredDraftTime, setRestoredDraftTime] = useState<string | null>(null);

  const [availableStyles, setAvailableStyles] = useState<StyleOption[]>(sampleStyles);
  const [availableAlbums, setAvailableAlbums] = useState<Array<{ id: string; name: string; trackCount: number }>>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string>('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PROJECT_DRAFT_KEY);
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft) {
          if (draft.name) setName(draft.name);
          if (draft.concept) setConcept(draft.concept);
          if (draft.style && !initialStyle) setStyle(draft.style);
          if (draft.videoSource === 'clip' || draft.videoSource === 'image') setVideoSource(draft.videoSource);
          if (draft.selectedAlbumId) setSelectedAlbumId(draft.selectedAlbumId);
          setRestoredDraftTime(draft.savedAt || 'Önceki oturum');
        }
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (initialStyle) {
      setStyle(initialStyle);
    } else {
      const params = new URLSearchParams(window.location.search);
      const urlStyle = params.get('style');
      if (urlStyle) {
        setStyle(urlStyle);
      }
    }
  }, [initialStyle]);

  useEffect(() => {
    let isActive = true;
    fetchProjects()
      .then((projects) => {
        if (!isActive) return;
        setExistingNames(projects.map((project) => project.name.toLowerCase()));
        setNamesState('loaded');
      })
      .catch(() => {
        if (isActive) setNamesState('error');
      });

    fetchLibrary()
      .then((lib) => {
        if (!isActive) return;
        if (Array.isArray(lib.styles) && lib.styles.length > 0) {
          setAvailableStyles(
            lib.styles.map((s) => {
              const sample = sampleStyles.find((item) => item.id === s.name);
              return {
                id: s.name,
                name: sample?.name ?? s.name,
                description: s.motionHints || s.styleBlock || sample?.description || 'Visual style option.',
              };
            }),
          );
        }
      })
      .catch(() => {
        // Fallback to defaults
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
      if (name || concept || selectedAlbumId) {
        localStorage.setItem(
          PROJECT_DRAFT_KEY,
          JSON.stringify({
            name,
            concept,
            style,
            videoSource,
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
    setVideoSource('clip');
    setSelectedAlbumId('');
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const nextErrors = validate({ name, style, existingNames });
    setErrors(nextErrors);
    setServerProblems([]);

    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    try {
      const response = await createProject({
        name: name.trim(),
        style,
        videoSource,
        concept: concept.trim() || undefined,
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

  const selectedStyle = availableStyles.find((option) => option.id === style);

  return (
    <section className="page narrow">
      <PageHeader
        eyebrow="NEW PROJECT"
        title="New Project"
        description="Set up the album, image style and visual for a new video."
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

        <div className="field">
          <label htmlFor="project-style">Image Style</label>
          <select
            id="project-style"
            value={style}
            onChange={(event) => edit(setStyle)(event.target.value)}
            aria-invalid={Boolean(errors.style)}
            aria-describedby="project-style-hint"
            disabled={isSubmitting}
          >
            <option value="">Select an image style</option>
            {availableStyles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <p id="project-style-hint" className={errors.style ? 'field-error' : 'field-hint'}>
            {errors.style ?? selectedStyle?.description ?? 'Choose the image style for the video.'}
          </p>
        </div>

        <fieldset className="field">
          <legend>Video visual</legend>
          <div className="option-list option-grid" role="radiogroup">
            {VIDEO_SOURCE_OPTIONS.map((option) => {
              const isSelected = videoSource === option.id;
              return (
                <label key={option.id} className={isSelected ? 'option selected' : 'option'}>
                  <input
                    type="radio"
                    name="video-source"
                    value={option.id}
                    checked={isSelected}
                    onChange={() => edit(setVideoSource)(option.id)}
                    disabled={isSubmitting}
                  />
                  <span>{option.name}</span>
                  <span className="muted">{option.description}</span>
                </label>
              );
            })}
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
  style,
  existingNames,
}: {
  name: string;
  style: string;
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

  if (!style) {
    errors.style = 'Select a style.';
  }

  return errors;
}

