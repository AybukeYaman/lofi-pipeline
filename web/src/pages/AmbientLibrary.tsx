import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { deleteAmbient, fetchLibrary, getAmbientAudioUrl, uploadAmbient } from '../api';
import { EmptyState, SampleDataNotice } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { sampleAmbients, type LibraryAmbient } from '../mockData';
import type { LibraryResponse, LoadState } from '../types';
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
  // Tek bir <audio> paylaşılıyor: iki ses birden çalmasın.
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** Aynı sese tekrar basmak durdurur; başka sese basmak ona geçer. */
  const togglePreview = (name: string) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (previewId === name) {
      audio.pause();
      setPreviewId(null);
      return;
    }
    audio.src = getAmbientAudioUrl(name);
    setPreviewId(name);
    void audio.play().catch(() => setPreviewId(null));
  };
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  // Sunucu yanıtını ekran listesine çeviren tek yer — ilk yükleme, ses ekleme
  // ve silme hep buradan geçiyor, üç ayrı eşleme kodu olmasın.
  const applyLibrary = useCallback((res: LibraryResponse) => {
    setAmbientErrorNotice(res.ambientError ?? null);
    const loaded: LibraryAmbient[] = (res.ambients ?? []).map((a) => {
      const sample = sampleAmbients.find((item) => item.id === a.name);
      return { id: a.name, name: a.name, category: sample?.category ?? 'Arka plan sesi' };
    });
    setAmbients(loaded);
  }, []);

  useEffect(() => {
    let isActive = true;
    fetchLibrary()
      .then((res) => {
        if (!isActive) return;
        // Boş liste de geçerli bir cevap: klasördeki son ses silindiğinde
        // ekranda hayalet satır kalmasın (eskiden boşsa örnek veri kalıyordu).
        applyLibrary(res);
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
  }, [applyLibrary]);

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

  /**
   * Sesi ortak klasöre YAZAR (eskiden yalnızca ekrana bir satır ekliyordu;
   * dosya hiçbir yere kopyalanmadığı için montaj adımındaki seçici onu
   * göremiyordu). Yanıt kütüphanenin diskten okunmuş güncel hali.
   */
  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    const name = draftName.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      setDraftError('Harf, rakam, - ve _ kullan (ör. softRain).');
      return;
    }
    if (ambients.some((ambient) => ambient.id === name)) {
      setDraftError('Bu adda bir Ambiance zaten var.');
      return;
    }
    if (!draftFile) {
      setDraftError('Bir ses dosyası seç.');
      return;
    }

    setIsSaving(true);
    setDraftError(null);
    try {
      applyLibrary(await uploadAmbient(name, draftFile));
      closeForm();
    } catch (error: unknown) {
      setDraftError(error instanceof Error ? error.message : 'Ambiance yüklenemedi.');
    } finally {
      setIsSaving(false);
    }
  };

  /** Ortak klasörden kaldırır — kalıcı silme değil, Geri Dönüşüm Kutusu'na. */
  const handleDelete = async (name: string) => {
    if (isSaving) return;
    setIsSaving(true);
    setListError(null);
    try {
      applyLibrary(await deleteAmbient(name));
      setSelectedIds((ids) => ids.filter((id) => id !== name));
    } catch (error: unknown) {
      setListError(error instanceof Error ? error.message : 'Ambiance silinemedi.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="page">
      <PageHeader
        eyebrow="KÜTÜPHANE"
        title="Arka Plan Sesleri"
        actions={
          <button
            className="button button-primary"
            type="button"
            onClick={() => (isAdding ? closeForm() : setIsAdding(true))}
            aria-expanded={isAdding}
          >
            {isAdding ? 'Kapat' : 'Arka Plan Sesi Ekle'}
          </button>
        }
      />

      {isBackendConnected ? null : <SampleDataNotice />}

      {ambientErrorNotice ? (
        <p className="notice notice-muted" role="alert">
          <strong>Arka plan sesi uyarısı</strong>
          <span>{ambientErrorNotice}</span>
        </p>
      ) : null}

      {isAdding ? (
        <form className="panel form" onSubmit={handleAdd} noValidate>
          <div className="field">
            <label htmlFor="ambient-name">Ad</label>
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
            <label htmlFor="ambient-file">Ses dosyası</label>
            <input
              id="ambient-file"
              type="file"
              accept={AUDIO_ACCEPT}
              onChange={(event) => {
                setDraftFile(event.target.files?.[0] ?? null);
                setDraftError(null);
              }}
            />
          </div>
          <p id="ambient-form-hint" className={draftError ? 'field-error' : 'field-hint'}>
            {draftError ?? 'Dosya ortak Ambiance klasörüne kopyalanır ve bütün projelerden seçilebilir.'}
          </p>
          <div className="form-actions">
            <button className="button" type="button" onClick={closeForm}>
              Cancel
            </button>
            <button className="button button-primary" type="submit" disabled={isSaving}>
              {isSaving ? 'Yükleniyor...' : 'Add'}
            </button>
          </div>
        </form>
      ) : null}

      {listError ? (
        <p className="field-hint field-error" role="alert">{listError}</p>
      ) : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Arka plan sesi ara"
          aria-label="Arka plan sesi ara"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="muted">
          {loadState === 'loading'
            ? 'Arka plan sesleri yükleniyor...'
            : `${visibleAmbients.length} ses · ${selectedIds.length} seçili`}
        </span>
      </div>

      {ambients.length === 0 ? (
        <EmptyState title="Henüz arka plan sesi yok." />
      ) : visibleAmbients.length === 0 ? (
        <EmptyState
          title="Aramaya uyan arka plan sesi yok."
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
                  aria-label={`${ambient.name} — ${isPreviewing ? 'durdur' : 'çal'}`}
                  onClick={() => togglePreview(ambient.name)}
                >
                  {isPreviewing ? '■' : '▶'}
                </button>
                <div className="library-list-body">
                  <strong>{ambient.name}</strong>
                  <span className="muted">
                    {isPreviewing ? 'Çalıyor...' : ambient.category}
                  </span>
                </div>
                <button
                  className={isSelected ? 'button button-selected' : 'button'}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggleSelected(ambient.id)}
                >
                  {isSelected ? 'Seçili' : 'Seç'}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={isSaving || !isBackendConnected}
                  title="Ortak klasörden kaldır (Geri Dönüşüm Kutusu'na gider)"
                  onClick={() => void handleDelete(ambient.name)}
                >
                  Sil
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Görünmez: oynatmayı listedeki ▶ düğmeleri yönetiyor. */}
      <audio
        ref={audioRef}
        preload="none"
        onEnded={() => setPreviewId(null)}
        onPause={() => setPreviewId(null)}
        style={{ display: 'none' }}
      />
    </section>
  );
}
