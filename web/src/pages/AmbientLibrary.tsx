import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { fetchLibrary } from '../api';
import { EmptyState, SampleDataNotice } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { sampleAmbients, type LibraryAmbient } from '../mockData';
import type { LoadState } from '../types';
import { matchesQuery } from './libraryFilter';

const AUDIO_ACCEPT = '.mp3,.wav,.m4a,.flac,.ogg';

export function AmbientLibrary() {
  const [ambients, setAmbients] = useState<LibraryAmbient[]>(sampleAmbients);
  const [ambientErrorNotice, setAmbientErrorNotice] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [isBackendConnected, setIsBackendConnected] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftFile, setDraftFile] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    fetchLibrary()
      .then((res) => {
        if (!isActive) return;
        setAmbientErrorNotice(res.ambientError ?? null);
        if (Array.isArray(res.ambients) && res.ambients.length > 0) {
          const loadedAmbients: LibraryAmbient[] = res.ambients.map((a) => {
            const sample = sampleAmbients.find((item) => item.id === a.name);
            return {
              id: a.name,
              name: a.name,
              category: sample?.category ?? 'Ambient sound',
            };
          });
          setAmbients(loadedAmbients);
        }
        setIsBackendConnected(true);
        setLoadState('loaded');
      })
      .catch(() => {
        if (isActive) {
          setIsBackendConnected(false);
          setLoadState('loaded');
        }
      });
    return () => {
      isActive = false;
    };
  }, []);

  const visibleAmbients = useMemo(
    () => ambients.filter((ambient) => matchesQuery(query, ambient.name, ambient.category)),
    [ambients, query],
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));
  };

  const closeForm = () => {
    setIsAdding(false);
    setDraftName('');
    setDraftFile(null);
    setDraftError(null);
  };

  const handleAdd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setDraftError('Use letters, numbers, - or _ (e.g. softRain).');
      return;
    }
    if (ambients.some((ambient) => ambient.id === name)) {
      setDraftError('An ambient with this name already exists.');
      return;
    }
    if (!draftFile) {
      setDraftError('Choose an audio file.');
      return;
    }
    setAmbients([
      ...ambients,
      { id: name, name, category: 'Custom', isLocalDraft: true, fileName: draftFile },
    ]);
    closeForm();
  };

  return (
    <section className="page">
      <PageHeader
        eyebrow="LIBRARY"
        title="Ambient"
        actions={
          <button
            className="button button-primary"
            type="button"
            onClick={() => (isAdding ? closeForm() : setIsAdding(true))}
            aria-expanded={isAdding}
          >
            {isAdding ? 'Close' : 'Add Ambient'}
          </button>
        }
      />

      {isBackendConnected ? null : <SampleDataNotice />}

      {ambientErrorNotice ? (
        <p className="notice notice-muted" role="alert">
          <strong>Ambient Library warning</strong>
          <span>{ambientErrorNotice}</span>
        </p>
      ) : null}

      {isAdding ? (
        <form className="panel form" onSubmit={handleAdd} noValidate>
          <div className="field">
            <label htmlFor="ambient-name">Name</label>
            <input
              id="ambient-name"
              value={draftName}
              onChange={(event) => {
                setDraftName(event.target.value);
                setDraftError(null);
              }}
              aria-invalid={Boolean(draftError)}
              aria-describedby="ambient-form-hint"
              autoComplete="off"
              placeholder="softRain"
            />
          </div>
          <div className="field">
            <label htmlFor="ambient-file">Audio file</label>
            <input
              id="ambient-file"
              type="file"
              accept={AUDIO_ACCEPT}
              onChange={(event) => {
                setDraftFile(event.target.files?.[0]?.name ?? null);
                setDraftError(null);
              }}
            />
          </div>
          <p id="ambient-form-hint" className={draftError ? 'field-error' : 'field-hint'}>
            {draftError ?? 'Added to this screen only. The file is not copied.'}
          </p>
          <div className="form-actions">
            <button className="button" type="button" onClick={closeForm}>
              Cancel
            </button>
            <button className="button button-primary" type="submit">
              Add
            </button>
          </div>
        </form>
      ) : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Search ambient"
          aria-label="Search ambient"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="muted">
          {loadState === 'loading'
            ? 'Loading ambient sounds...'
            : `${visibleAmbients.length} sounds · ${selectedIds.length} selected`}
        </span>
      </div>

      {ambients.length === 0 ? (
        <EmptyState title="No ambient sounds yet." />
      ) : visibleAmbients.length === 0 ? (
        <EmptyState
          title="No ambient sounds match your search."
          action={
            <button className="button" type="button" onClick={() => setQuery('')}>
              Clear search
            </button>
          }
        />
      ) : (
        <ul className="panel library-list">
          {visibleAmbients.map((ambient) => {
            const isSelected = selectedIds.includes(ambient.id);
            const isPreviewing = previewId === ambient.id;
            return (
              <li key={ambient.id} className={isSelected ? 'selected' : undefined}>
                <button
                  className="play-button"
                  type="button"
                  aria-pressed={isPreviewing}
                  aria-label={`${isPreviewing ? 'Stop' : 'Play'} ${ambient.name}`}
                  onClick={() => setPreviewId(isPreviewing ? null : ambient.id)}
                >
                  {isPreviewing ? '■' : '▶'}
                </button>
                <div className="library-list-body">
                  <strong>{ambient.name}</strong>
                  <span className="muted">
                    {isPreviewing
                      ? 'Audio preview not connected yet'
                      : [ambient.category, ambient.fileName].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {ambient.isLocalDraft ? <StatusBadge status="optional" label="Local draft" /> : null}
                <button
                  className={isSelected ? 'button button-selected' : 'button'}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleSelected(ambient.id)}
                >
                  {isSelected ? 'Selected' : 'Select'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
