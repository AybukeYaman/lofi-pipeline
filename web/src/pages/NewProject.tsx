import { useEffect, useState, type FormEvent } from 'react';

import { createProject, fetchLibrary, fetchProjects, ApiError } from '../api';
import { PageHeader } from '../components/PageHeader';
import { ReferencePicker, type ReferenceDraft } from '../components/ReferencePicker';
import { sampleAmbients, sampleStyles } from '../mockData';
import type { LoadState } from '../types';

type FormErrors = Partial<Record<'name' | 'style' | 'form', string>>;

const INVALID_NAME_CHARS = /[<>:"/\\|?* - ]/;

type StyleOption = { id: string; name: string; description: string };
type AmbientOption = { id: string; name: string; category: string };

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
  const [ambients, setAmbients] = useState<string[]>([]);
  const [references, setReferences] = useState<ReferenceDraft[]>([]);
  const [errors, setErrors] = useState<FormErrors>({});
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [namesState, setNamesState] = useState<LoadState>('loading');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverProblems, setServerProblems] = useState<string[]>([]);

  const [availableStyles, setAvailableStyles] = useState<StyleOption[]>(sampleStyles);
  const [availableAmbients, setAvailableAmbients] = useState<AmbientOption[]>(sampleAmbients);

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
        if (Array.isArray(lib.ambients) && lib.ambients.length > 0) {
          setAvailableAmbients(
            lib.ambients.map((a) => {
              const sample = sampleAmbients.find((item) => item.id === a.name);
              return {
                id: a.name,
                name: a.name,
                category: sample?.category ?? 'Ambient',
              };
            }),
          );
        }
      })
      .catch(() => {
        // Fallback to defaults
      });

    return () => {
      isActive = false;
    };
  }, []);

  const edit = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setErrors((prev) => ({ ...prev, form: undefined }));
    setServerProblems([]);
  };

  const toggleAmbient = (id: string) => {
    edit(setAmbients)(
      ambients.includes(id) ? ambients.filter((other) => other !== id) : [...ambients, id],
    );
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
        ambient: ambients.length > 0 ? ambients : undefined,
        concept: concept.trim() || undefined,
      });

      if (onCreated) {
        onCreated(response.project.id);
      }
    } catch (err: unknown) {
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

  const selectedStyle = availableStyles.find((option) => option.id === style);

  return (
    <section className="page narrow">
      <PageHeader
        eyebrow="NEW PROJECT"
        title="New Project"
        description="Set up the album, visual style and ambience for a new video."
      />

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
          <label htmlFor="project-style">Style</label>
          <select
            id="project-style"
            value={style}
            onChange={(event) => edit(setStyle)(event.target.value)}
            aria-invalid={Boolean(errors.style)}
            aria-describedby="project-style-hint"
            disabled={isSubmitting}
          >
            <option value="">Select a style</option>
            {availableStyles.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
          <p id="project-style-hint" className={errors.style ? 'field-error' : 'field-hint'}>
            {errors.style ?? selectedStyle?.description ?? 'Choose the visual style for the video.'}
          </p>
        </div>

        <fieldset className="field">
          <legend>Ambient</legend>
          <div className="option-list option-grid">
            {availableAmbients.map((ambient) => {
              const isSelected = ambients.includes(ambient.id);
              return (
                <label key={ambient.id} className={isSelected ? 'option selected' : 'option'}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleAmbient(ambient.id)}
                    disabled={isSubmitting}
                  />
                  <span>{ambient.name}</span>
                  <span className="muted">{ambient.category}</span>
                </label>
              );
            })}
          </div>
          <p className="field-hint">Optional. Mixed under the music.</p>
        </fieldset>

        <fieldset className="field">
          <legend>References</legend>
          <ReferencePicker items={references} onChange={edit(setReferences)} />
        </fieldset>

        <div className="form-actions">
          <button className="button" type="button" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button className="button button-primary" type="submit" disabled={isSubmitting}>
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

