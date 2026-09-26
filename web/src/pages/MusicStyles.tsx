import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { ApiError, createLibraryStyleApi, deleteStyleDetail, fetchLibrary, updateStyleDetail } from '../api';
import { EmptyState } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import { MUSIC_FIELDS, musicItems, musicSummary } from '../musicStyle';
import { showError, showSuccess } from '../toast';
import type { BackendStyle, LoadState, StyleMusic } from '../types';
import { matchesQuery } from './libraryFilter';

/** Stil adı: küçük harf kebab-case — sunucudaki STYLE_NAME_PATTERN ile aynı. */
const STYLE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Draft = {
  /** Düzenlenen stilin eski adı; yeni stil için null. */
  original: string | null;
  name: string;
  fields: Record<keyof StyleMusic, string>;
  suggestedAmbient: string;
};

const EMPTY_FIELDS = Object.fromEntries(MUSIC_FIELDS.map((field) => [field.key, ''])) as Draft['fields'];

function draftFrom(style: BackendStyle | null): Draft {
  if (!style) return { original: null, name: '', fields: { ...EMPTY_FIELDS }, suggestedAmbient: '' };
  const fields = { ...EMPTY_FIELDS };
  for (const { key } of MUSIC_FIELDS) fields[key] = musicItems(style.music?.[key]).join(', ');
  return { original: style.name, name: style.name, fields, suggestedAmbient: style.suggestedAmbient ?? '' };
}

/** Form metinleri → music bloğu. Tür ve estetik tek metin, diğerleri virgülle ayrılmış liste. */
function musicFrom(fields: Draft['fields']): StyleMusic | null {
  const music: StyleMusic = {};
  for (const { key } of MUSIC_FIELDS) {
    const items = musicItems(fields[key].split(','));
    if (items.length === 0) continue;
    music[key] = key === 'genre' || key === 'aesthetic' ? items.join(', ') : items;
  }
  return Object.keys(music).length > 0 ? music : null;
}

export function MusicStyles({ onUseStyle }: { onUseStyle?: (styleName: string) => void }) {
  const [styles, setStyles] = useState<BackendStyle[]>([]);
  const [ambients, setAmbients] = useState<string[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const library = await fetchLibrary();
      setStyles(library.styles);
      setAmbients(library.ambients.map((ambient) => ambient.name));
      setLoadState('loaded');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => styles.filter((style) => matchesQuery(query, style.name, musicSummary(style.music) ?? '')),
    [styles, query],
  );

  const openForm = (style: BackendStyle | null) => {
    setDraft(draftFrom(style));
    setFormError(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || saving) return;
    const name = draft.name.trim();
    if (!STYLE_NAME_PATTERN.test(name)) {
      setFormError('Use lowercase letters, digits and dashes (e.g. night-lofi).');
      return;
    }
    const payload = { name, music: musicFrom(draft.fields), suggestedAmbient: draft.suggestedAmbient };
    setSaving(true);
    setFormError(null);
    try {
      if (draft.original) {
        await updateStyleDetail(draft.original, payload);
      } else {
        await createLibraryStyleApi({ ...payload, music: payload.music ?? undefined });
      }
      showSuccess(`"${name}" kaydedildi.`, 'Music style');
      setDraft(null);
      await load();
    } catch (err: unknown) {
      const problems = err instanceof ApiError ? err.problems : undefined;
      setFormError(problems?.length ? problems.join(' · ') : err instanceof Error ? err.message : 'Style could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (style: BackendStyle) => {
    if (!window.confirm(`"${style.name}" müzik stili silinsin mi?`)) return;
    try {
      await deleteStyleDetail(style.name);
      showSuccess(`"${style.name}" silindi.`, 'Music style');
      await load();
    } catch (err: unknown) {
      showError(err, 'Stil silinemedi.');
    }
  };

  return (
    <section className="page">
      <PageHeader
        eyebrow="LIBRARY"
        title="Music Styles"
        description="Music profiles for album planning. Images are made by you, so a style only describes the sound."
        actions={
          <button className="button button-primary" type="button" onClick={() => openForm(null)}>
            New Music Style
          </button>
        }
      />

      {draft ? (
        <form className="panel form" onSubmit={save} noValidate>
          <div className="field">
            <label htmlFor="style-name">Name</label>
            <input
              id="style-name"
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="night-lofi"
              autoComplete="off"
              disabled={saving}
            />
          </div>
          {MUSIC_FIELDS.map((field) => (
            <div className="field" key={field.key}>
              <label htmlFor={`style-${field.key}`}>{field.label}</label>
              <input
                id={`style-${field.key}`}
                value={draft.fields[field.key]}
                onChange={(event) => setDraft({ ...draft, fields: { ...draft.fields, [field.key]: event.target.value } })}
                placeholder={field.hint}
                disabled={saving}
              />
            </div>
          ))}
          <div className="field">
            <label htmlFor="style-ambient">Suggested ambient</label>
            <select
              id="style-ambient"
              value={draft.suggestedAmbient}
              onChange={(event) => setDraft({ ...draft, suggestedAmbient: event.target.value })}
              disabled={saving}
            >
              <option value="">None</option>
              {ambients.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <p className="field-hint">Comma-separated values become lists. Leave everything empty for an empty profile.</p>
          </div>
          {formError ? (
            <p className="field-error" role="alert">
              {formError}
            </p>
          ) : null}
          <div className="form-actions">
            <button className="button" type="button" onClick={() => setDraft(null)} disabled={saving}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search styles"
          aria-label="Search styles"
        />
        <span className="muted">{visible.length} styles</span>
      </div>

      {loadState === 'error' ? (
        <div className="state-card" role="alert">
          Styles could not be loaded.
        </div>
      ) : null}
      {loadState === 'loaded' && visible.length === 0 ? <EmptyState title="No music styles." /> : null}

      {visible.length > 0 ? (
        <ul className="panel library-list style-list">
          {visible.map((style) => {
            const summary = musicSummary(style.music);
            return (
              <li key={style.name}>
                <div className="library-list-body">
                  <strong>{style.name}</strong>
                  <span className="muted">
                    {!style.valid
                      ? `Invalid: ${style.problems?.join(' · ') ?? ''}`
                      : summary ?? 'Music profile empty — edit to fill it.'}
                    {style.suggestedAmbient ? ` · ambient: ${style.suggestedAmbient}` : ''}
                  </span>
                </div>
                <StatusBadge
                  status={!style.valid ? 'missing' : style.hasMusicProfile ? 'ready' : 'optional'}
                  label={!style.valid ? 'Invalid' : style.hasMusicProfile ? 'Profile' : 'Empty'}
                />
                <div className="library-actions">
                  {style.valid && onUseStyle ? (
                    <button className="button" type="button" onClick={() => onUseStyle(style.name)}>
                      Use in project
                    </button>
                  ) : null}
                  {style.valid ? (
                    <button className="button" type="button" onClick={() => openForm(style)}>
                      Edit
                    </button>
                  ) : null}
                  <button className="button project-delete" type="button" onClick={() => remove(style)}>
                    Sil
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
