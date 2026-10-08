/**
 * Promptlar — kullanıcının kendi promptlarının kütüphanesi.
 *
 * Projeden ve aşamadan bağımsız: sol menüden her an açılır, karttaki Kopyala
 * ile prompt panoya gider. Ekleme/düzenleme/silme de burada — kullanıcı dosya
 * klasörüne hiç girmez (Music Styles sayfasıyla aynı kalıp).
 */

import { useEffect, useMemo, useState } from 'react';

import {
  copyTextToClipboard,
  createLibraryPrompt,
  deleteLibraryPrompt,
  fetchPromptLibrary,
  updateLibraryPrompt,
} from '../api';
import { EmptyState } from '../components/Feedback';
import { matchesQuery } from './libraryFilter';
import { PageHeader } from '../components/PageHeader';
import type { LibraryPrompt, LoadState, PromptTag } from '../types';

/** Etiketlerin görünen adı — depodaki değerler İngilizce, arayüz Türkçe. */
const TAG_LABELS: Record<PromptTag, string> = {
  general: 'Genel',
  image: 'Görsel',
  music: 'Müzik',
  video: 'Video',
};

const ALL_TAGS: PromptTag[] = ['general', 'image', 'music', 'video'];

type Draft = { title: string; text: string; note: string; tags: PromptTag[] };

const EMPTY_DRAFT: Draft = { title: '', text: '', note: '', tags: ['general'] };

const draftFrom = (prompt: LibraryPrompt): Draft => ({
  title: prompt.title,
  text: prompt.text,
  note: prompt.note ?? '',
  tags: prompt.tags.length > 0 ? prompt.tags : ['general'],
});

export function PromptLibrary() {
  const [prompts, setPrompts] = useState<LibraryPrompt[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<PromptTag | 'all'>('all');
  const [search, setSearch] = useState('');
  /** null: form kapalı · 'new': ekleme · başka: o promptu düzenleme. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await fetchPromptLibrary();
      setPrompts(data.prompts);
      setState('loaded');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promptlar yüklenemedi.');
      setState('error');
    }
  };

  useEffect(() => { void load(); }, []);

  const visible = useMemo(
    () =>
      prompts.filter((prompt) => {
        if (filter !== 'all' && !prompt.tags.includes(filter)) return false;
        return matchesQuery(search, prompt.title, prompt.text, prompt.note);
      }),
    [prompts, filter, search],
  );

  const handleCopy = async (prompt: LibraryPrompt) => {
    setError(null);
    const ok = await copyTextToClipboard(prompt.text);
    if (ok) {
      setCopiedId(prompt.id);
      setNotice(`"${prompt.title}" panoya kopyalandı.`);
      window.setTimeout(() => setCopiedId(null), 2000);
    } else {
      setError('Panoya kopyalanamadı — metni aşağıdan elle seçip kopyalayabilirsin.');
    }
  };

  const openNew = () => {
    setEditing('new');
    setDraft(EMPTY_DRAFT);
    setError(null);
    setNotice(null);
  };

  const openEdit = (prompt: LibraryPrompt) => {
    setEditing(prompt.id);
    setDraft(draftFrom(prompt));
    setError(null);
    setNotice(null);
  };

  const closeForm = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  const handleSave = async () => {
    if (draft.title.trim() === '' || draft.text.trim() === '') {
      setError('Başlık ve prompt metni zorunlu.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const payload = {
        title: draft.title.trim(),
        text: draft.text,
        note: draft.note.trim() === '' ? null : draft.note.trim(),
        tags: draft.tags.length > 0 ? draft.tags : (['general'] as PromptTag[]),
      };
      if (editing === 'new') {
        const { prompt } = await createLibraryPrompt(payload);
        setNotice(`"${prompt.title}" kaydedildi.`);
      } else if (editing) {
        const { prompt } = await updateLibraryPrompt(editing, payload);
        setNotice(`"${prompt.title}" güncellendi.`);
      }
      closeForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prompt kaydedilemedi.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (prompt: LibraryPrompt) => {
    // Silme geri alınamaz: onay al.
    if (!window.confirm(`"${prompt.title}" silinsin mi? Bu geri alınamaz.`)) return;
    setError(null);
    try {
      await deleteLibraryPrompt(prompt.id);
      setNotice(`"${prompt.title}" silindi.`);
      if (editing === prompt.id) closeForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Prompt silinemedi.');
    }
  };

  const toggleTag = (tag: PromptTag) => {
    setDraft((current) => ({
      ...current,
      tags: current.tags.includes(tag)
        ? current.tags.filter((t) => t !== tag)
        : [...current.tags, tag],
    }));
  };

  return (
    <section>
      <PageHeader
        title="Promptlar"
        description="Kendi promptlarını burada tut, her an kopyala. Projeye girmen ya da bir aşamaya geçmen gerekmez."
        actions={
          <button type="button" className="button primary" onClick={openNew} disabled={editing === 'new'}>
            + Yeni prompt
          </button>
        }
      />

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-success" role="status">{notice}</p> : null}

      {editing !== null ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>{editing === 'new' ? 'Yeni prompt' : 'Promptu düzenle'}</h3>
          <label className="field">
            <span>Başlık</span>
            <input
              type="text"
              value={draft.title}
              maxLength={120}
              placeholder="Örn. Müzik ambiyans tanımı"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Prompt metni</span>
            <textarea
              rows={10}
              value={draft.text}
              placeholder="Kopyalanacak metnin tamamı"
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Not (isteğe bağlı — kopyalanmaz)</span>
            <input
              type="text"
              value={draft.note}
              maxLength={500}
              placeholder="Bu promptu ne zaman kullanıyorsun?"
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </label>
          <div className="field">
            <span>Etiketler</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {ALL_TAGS.map((tag) => (
                <label key={tag} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={draft.tags.includes(tag)} onChange={() => toggleTag(tag)} />
                  {TAG_LABELS[tag]}
                </label>
              ))}
            </div>
            <p className="field-hint">
              "Müzik" etiketli promptlar proje içindeki Müzik adımında da görünür.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button primary" onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? 'Kaydediliyor...' : 'Kaydet'}
            </button>
            <button type="button" className="button" onClick={closeForm} disabled={isSaving}>
              Vazgeç
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 14px' }}>
        <input
          type="search"
          value={search}
          placeholder="Promptlarda ara..."
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: '1 1 220px', minWidth: 180 }}
        />
        <div role="group" aria-label="Etikete göre süz" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['all', ...ALL_TAGS] as const).map((tag) => (
            <button
              key={tag}
              type="button"
              className={`button${filter === tag ? ' primary' : ''}`}
              style={{ fontSize: 12, minHeight: 28, padding: '2px 10px' }}
              onClick={() => setFilter(tag)}
            >
              {tag === 'all' ? 'Tümü' : TAG_LABELS[tag]}
            </button>
          ))}
        </div>
      </div>

      {state === 'loading' ? <p>Yükleniyor...</p> : null}

      {state === 'loaded' && prompts.length === 0 ? (
        <EmptyState title="Henüz prompt yok.">
          "+ Yeni prompt" ile ilk promptunu ekle; bundan sonra tek tıkla kopyalarsın.
        </EmptyState>
      ) : null}

      {state === 'loaded' && prompts.length > 0 && visible.length === 0 ? (
        <EmptyState compact title="Bu süzgeçle eşleşen prompt yok." />
      ) : null}

      <div style={{ display: 'grid', gap: 12 }}>
        {visible.map((prompt) => (
          <article key={prompt.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ margin: '0 0 4px' }}>{prompt.title}</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {prompt.tags.map((tag) => (
                    <span key={tag} className="count">{TAG_LABELS[tag] ?? tag}</span>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void handleCopy(prompt)}
                  disabled={Boolean(prompt.error)}
                >
                  {copiedId === prompt.id ? '✓ Kopyalandı' : 'Kopyala'}
                </button>
                <button type="button" className="button" onClick={() => openEdit(prompt)}>Düzenle</button>
                <button type="button" className="button" onClick={() => void handleDelete(prompt)}>Sil</button>
              </div>
            </div>

            {prompt.error ? (
              <p className="form-error">Dosya okunamadı: {prompt.error}</p>
            ) : (
              <>
                {prompt.note ? <p className="field-hint">{prompt.note}</p> : null}
                <pre
                  style={{
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '8px 0 0',
                    maxHeight: 180, overflow: 'auto', fontSize: 13, lineHeight: 1.5,
                  }}
                >
                  {prompt.text}
                </pre>
              </>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
