import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { fetchLibrary, ApiError } from '../api';
import { EmptyState, SampleDataNotice } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { ReferencePicker, type ReferenceDraft } from '../components/ReferencePicker';
import { StatusBadge } from '../components/StatusBadge';
import { sampleAmbients, sampleStyles, type LibraryStyle } from '../mockData';
import type { BackendStyle, LoadState } from '../types';
import { matchesQuery } from './libraryFilter';

const DRAFT_PALETTE: LibraryStyle['palette'] = ['#4a4540', '#9a9084', '#e2dbd0'];

function extractPalette(s: BackendStyle): [string, string, string] {
  const block = typeof s.styleBlock === 'object' && s.styleBlock !== null ? (s.styleBlock as { palette?: unknown[] }) : null;
  if (block && Array.isArray(block.palette)) {
    const hexes = block.palette
      .map((item: unknown) => (typeof item === 'string' ? item : (item as { hex?: string })?.hex))
      .filter((hex: unknown): hex is string => typeof hex === 'string' && hex.startsWith('#'));
    if (hexes.length >= 3) return [hexes[0], hexes[1], hexes[2]];
    if (hexes.length === 2) return [hexes[0], hexes[1], DRAFT_PALETTE[2]];
    if (hexes.length === 1) return [hexes[0], DRAFT_PALETTE[1], DRAFT_PALETTE[2]];
  }
  const sample = sampleStyles.find((item) => item.id === s.name);
  return sample?.palette ?? DRAFT_PALETTE;
}

function extractDescription(s: BackendStyle): string {
  if (s.name === 'custom-generated') {
    return 'Multi-reference visual style synthesizer. Generates custom style block from reference images.';
  }
  if (typeof s.motionHints === 'string' && s.motionHints.trim()) {
    return s.motionHints;
  }
  if (Array.isArray(s.motionHints) && s.motionHints.length > 0) {
    return s.motionHints.join(' · ');
  }
  if (typeof s.styleBlock === 'string' && s.styleBlock.trim()) {
    return s.styleBlock.slice(0, 150);
  }
  const sample = sampleStyles.find((item) => item.id === s.name);
  return sample?.description || (s.valid ? 'Visual style option.' : 'Invalid style configuration.');
}

function normalizeAmbient(ambient: string[] | string | null | undefined): string[] {
  if (Array.isArray(ambient)) return ambient;
  if (typeof ambient === 'string' && ambient.trim()) return [ambient.trim()];
  return [];
}

export function StyleLibrary({ onUseStyle }: { onUseStyle?: (styleId: string) => void }) {
  const [styles, setStyles] = useState<LibraryStyle[]>(sampleStyles);
  const [availableAmbients, setAvailableAmbients] = useState<string[]>(sampleAmbients.map((a) => a.name));
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isBackendConnected, setIsBackendConnected] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Custom style creation workflow state
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftConcept, setDraftConcept] = useState('');
  const [draftReferences, setDraftReferences] = useState<ReferenceDraft[]>([]);
  const [draftAmbients, setDraftAmbients] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const loadLibrary = async () => {
    try {
      const res = await fetchLibrary();
      if (Array.isArray(res.styles) && res.styles.length > 0) {
        const loadedStyles: LibraryStyle[] = res.styles.map((s) => {
          const sample = sampleStyles.find((item) => item.id === s.name);
          return {
            id: s.name,
            name: sample?.name ?? s.name,
            description: extractDescription(s),
            palette: extractPalette(s),
            suggestedAmbient: normalizeAmbient(s.suggestedAmbient ?? sample?.suggestedAmbient),
          };
        });
        setStyles(loadedStyles);
      }
      if (Array.isArray(res.ambients) && res.ambients.length > 0) {
        setAvailableAmbients(res.ambients.map((a) => a.name));
      }
      setIsBackendConnected(true);
      setLoadState('loaded');
    } catch {
      setIsBackendConnected(false);
      setLoadState('loaded');
    }
  };

  useEffect(() => {
    loadLibrary();
  }, []);

  const visibleStyles = useMemo(
    () => styles.filter((style) => matchesQuery(query, style.name, style.id, style.description)),
    [styles, query],
  );

  const closeForm = () => {
    setIsAdding(false);
    setDraftName('');
    setDraftConcept('');
    setDraftReferences([]);
    setDraftAmbients([]);
    setDraftError(null);
  };

  const toggleAmbient = (ambientName: string) => {
    setDraftAmbients((prev) =>
      prev.includes(ambientName) ? prev.filter((a) => a !== ambientName) : [...prev, ambientName],
    );
  };

  const handleCreateCustomStyle = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isGenerating) return;

    const rawName = draftName.trim();
    const styleId = slugify(rawName);

    if (!rawName) {
      setDraftError('Style name is required.');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(styleId)) {
      setDraftError('Use lowercase letters, numbers and hyphens (e.g. cyber-lofi).');
      return;
    }
    if (styles.some((s) => s.id === styleId)) {
      setDraftError(`A style with ID "${styleId}" already exists.`);
      return;
    }

    setIsGenerating(true);
    setDraftError(null);
    setSuccessMessage(null);

    try {
      // Attempt backend API if available
      const payload = {
        name: styleId,
        concept: draftConcept.trim() || undefined,
        referenceImages: draftReferences.map((r) => r.name),
        suggestedAmbient: draftAmbients.length > 0 ? draftAmbients : undefined,
      };

      const res = await fetch('/api/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => null);

      if (res && !res.ok && res.status !== 404) {
        const errorBody = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        throw new ApiError(
          res.status,
          (typeof errorBody?.error === 'string' && errorBody.error) || 'Could not create style',
        );
      }

      // Refresh real backend library state
      await loadLibrary();

      setSelectedId(styleId);
      setSuccessMessage(`Custom style "${styleId}" created successfully!`);
      closeForm();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setDraftError(err.message);
      } else {
        setDraftError(err instanceof Error ? err.message : 'Could not generate custom style.');
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const selectedStyle = styles.find((s) => s.id === selectedId);

  return (
    <section className="page">
      <PageHeader
        eyebrow="LIBRARY"
        title="Styles"
        actions={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {selectedStyle && onUseStyle ? (
              <button
                className="button button-primary"
                type="button"
                onClick={() => onUseStyle(selectedStyle.id)}
              >
                Use in New Project ({selectedStyle.name}) →
              </button>
            ) : null}
            <button
              className="button"
              type="button"
              onClick={() => (isAdding ? closeForm() : setIsAdding(true))}
              aria-expanded={isAdding}
            >
              {isAdding ? 'Close' : '+ Create Custom Style'}
            </button>
          </div>
        }
      />

      {isBackendConnected ? null : <SampleDataNotice />}

      {successMessage ? (
        <div className="notice" style={{ borderColor: '#cfe0d2', background: '#e9f2ea', color: '#34603f' }}>
          <strong>✓ Success:</strong> {successMessage}
        </div>
      ) : null}

      {isAdding ? (
        <form className="panel form" onSubmit={handleCreateCustomStyle} noValidate style={{ marginBottom: 24 }}>
          <h2>Create Custom Visual Style</h2>
          <p className="field-hint" style={{ marginBottom: 12 }}>
            Synthesize a new visual style language from reference images and theme prompt.
          </p>

          <div className="field">
            <label htmlFor="style-name">Style Name (ID)</label>
            <input
              id="style-name"
              value={draftName}
              placeholder="e.g. rainy-cyberpunk-lofi"
              onChange={(event) => {
                setDraftName(event.target.value);
                setDraftError(null);
              }}
              aria-invalid={Boolean(draftError)}
              aria-describedby="style-name-hint"
              autoComplete="off"
              disabled={isGenerating}
            />
            <p id="style-name-hint" className={draftError ? 'field-error' : 'field-hint'}>
              {draftError ?? `Saved as kebab-case: ${slugify(draftName || 'style-name')}`}
            </p>
          </div>

          <div className="field">
            <label htmlFor="style-concept">Style Concept & Atmosphere Context</label>
            <textarea
              id="style-concept"
              rows={2}
              placeholder="e.g. Rainy neon street lights reflecting on wet asphalt with muted warm colors"
              value={draftConcept}
              onChange={(event) => setDraftConcept(event.target.value)}
              disabled={isGenerating}
            />
            <p className="field-hint">Used to guide palette synthesis and lighting characteristics.</p>
          </div>

          <fieldset className="field">
            <legend>Reference Images</legend>
            <ReferencePicker
              items={draftReferences}
              onChange={setDraftReferences}
              emptyLabel="Add reference images (.jpg, .png, .webp) to extract visual style"
            />
          </fieldset>

          {availableAmbients.length > 0 ? (
            <fieldset className="field">
              <legend>Suggested Ambient Tracks</legend>
              <div className="option-list option-grid">
                {availableAmbients.map((ambient) => {
                  const isChecked = draftAmbients.includes(ambient);
                  return (
                    <label key={ambient} className={isChecked ? 'option selected' : 'option'}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleAmbient(ambient)}
                        disabled={isGenerating}
                      />
                      <span>{ambient}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <div className="form-actions">
            <button className="button" type="button" onClick={closeForm} disabled={isGenerating}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={isGenerating}>
              {isGenerating ? 'Generating Visual Style...' : 'Create Style'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Search styles"
          aria-label="Search styles"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="muted">
          {loadState === 'loading' ? 'Loading styles...' : `${visibleStyles.length} styles`}
        </span>
      </div>

      {styles.length === 0 ? (
        <EmptyState title="No styles yet." />
      ) : visibleStyles.length === 0 ? (
        <EmptyState
          title="No styles match your search."
          action={
            <button className="button" type="button" onClick={() => setQuery('')}>
              Clear search
            </button>
          }
        />
      ) : (
        <div className="library-grid">
          {visibleStyles.map((style) => {
            const isSelected = style.id === selectedId;
            return (
              <button
                key={style.id}
                type="button"
                className={isSelected ? 'library-card selected' : 'library-card'}
                aria-pressed={isSelected}
                onClick={() => setSelectedId(isSelected ? null : style.id)}
              >
                <div className="swatch" aria-hidden="true">
                  {style.palette.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </div>
                <div className="library-card-body">
                  <div className="library-card-title">
                    <strong>{style.name}</strong>
                    {isSelected ? <StatusBadge status="selected" label="Selected" /> : null}
                    {style.id === 'custom-generated' ? (
                      <StatusBadge status="processing" label="Custom Multi-Ref" />
                    ) : null}
                  </div>
                  <code>{style.id}</code>
                  <p>{style.description}</p>
                  {style.suggestedAmbient.length > 0 ? (
                    <p className="muted">Ambient: {style.suggestedAmbient.join(', ')}</p>
                  ) : null}
                  {isSelected && onUseStyle ? (
                    <div style={{ marginTop: 10 }}>
                      <span className="button button-primary" style={{ display: 'inline-block', fontSize: 13, minHeight: 32, lineHeight: '30px', padding: '0 12px' }}>
                        Use in New Project →
                      </span>
                    </div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

