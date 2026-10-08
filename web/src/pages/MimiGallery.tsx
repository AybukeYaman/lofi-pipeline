import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  convertMimiImageToLoop,
  deleteMimiAsset,
  fetchMimiGallery,
  openMimiFolder,
  uploadMimiAsset,
} from '../api';
import { EmptyState } from '../components/Feedback';
import { formatDateTime, formatSize } from '../format';
import { PageHeader } from '../components/PageHeader';
import { IMAGE_ACCEPT } from '../imageTypes';
import type { LoadState, MimiAsset, MimiGalleryResponse } from '../types';
import { matchesQuery } from './libraryFilter';

/** Sunucudaki server/mimi-api.js MIMI_VIDEO_EXTENSIONS ile aynı liste. */
const VIDEO_ACCEPT = '.mp4,.webm,.mov,.m4v';
const MIMI_ACCEPT = `${IMAGE_ACCEPT},${VIDEO_ACCEPT}`;

/** server/mimi-api.js LOOP_SECONDS_CHOICES aynası. */
const LOOP_SECONDS_CHOICES = [5, 10, 15, 30];

type KindFilter = 'all' | 'image' | 'video' | 'pending';

const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: 'Hepsi' },
  { id: 'image', label: 'Resimler' },
  { id: 'video', label: 'Videolar' },
  { id: 'pending', label: 'Video bekleyen' },
];

const ROLE_LABELS: Record<MimiAsset['role'], string> = {
  image: 'RESİM',
  loop: 'LOOP VİDEO',
  video: 'VİDEO',
};

/**
 * Mimi Galerisi — üretilip indirilen resim ve videoların durduğu yer.
 *
 * Projelerden bağımsız: ortak bir klasörü gösterir, oraya dosya yükler,
 * önizler ve istenmeyeni Geri Dönüşüm Kutusu'na yollar. Dosyalar Explorer'dan
 * klasöre atıldığında da listede görünür ("Klasörü Aç" bunun için).
 *
 * Resimlerin bir kısmının loop videoya çevrilmesi gerekiyor: her kart
 * "resim → video" şeridiyle dönüşümün hangi aşamada olduğunu gösterir
 * (video yok / çevriliyor / hazır), eşleştirme `<ad>.loop.mp4` adından gelir.
 */
export function MimiGallery() {
  const [items, setItems] = useState<MimiAsset[]>([]);
  const [dir, setDir] = useState<string>('');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [loopSeconds, setLoopSeconds] = useState(LOOP_SECONDS_CHOICES[0]);
  /** Şu anda ffmpeg'de olan resimler — kartta "Çevriliyor..." göstermek için. */
  const [converting, setConverting] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applyGallery = useCallback((res: MimiGalleryResponse) => {
    setItems(res.items ?? []);
    setDir(res.dir ?? '');
    setFolderError(res.error ?? null);
  }, []);

  const reload = useCallback(async () => {
    try {
      applyGallery(await fetchMimiGallery());
      setLoadState('loaded');
      setListError(null);
    } catch (error: unknown) {
      setLoadState('error');
      setListError(error instanceof Error ? error.message : 'Galeri yüklenemedi.');
    }
  }, [applyGallery]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const byFile = useMemo(
    () => new Map(items.map((item) => [item.file, item])),
    [items],
  );

  const visible = useMemo(
    () => items.filter((item) => {
      const kindOk = kind === 'all'
        || (kind === 'pending' ? item.needsVideo : item.kind === kind);
      return kindOk && matchesQuery(query, item.name, item.file);
    }),
    [items, kind, query],
  );

  const preview = useMemo(
    () => (openFile ? byFile.get(openFile) ?? null : null),
    [byFile, openFile],
  );

  // Büyük önizleme Esc ile kapanır: fare kartın üstünden kaymasın diye.
  useEffect(() => {
    if (!preview) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenFile(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [preview]);

  /** Seçilen dosyaları tek tek yükler; biri hata verirse diğerleri sürer. */
  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0 || busy) return;
    setBusy(true);
    setListError(null);
    setNotice(null);
    const failed: string[] = [];
    let added = 0;
    for (const file of Array.from(files)) {
      try {
        applyGallery(await uploadMimiAsset(file));
        added += 1;
      } catch (error: unknown) {
        failed.push(`${file.name}: ${error instanceof Error ? error.message : 'yüklenemedi'}`);
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
    setBusy(false);
    setNotice(added > 0 ? `${added} dosya eklendi.` : null);
    if (failed.length > 0) setListError(failed.join(' · '));
  };

  /**
   * Resmi loop videoya çevirir. Video zaten varsa (yeniden üretim) kullanıcıya
   * sorulur — üretilmiş dosyanın sessizce ezilmemesi için sunucu da 409 veriyor.
   */
  const handleConvert = async (item: MimiAsset) => {
    if (converting.includes(item.file)) return;
    const regenerate = item.loopVideo !== null;
    if (regenerate && !window.confirm(`"${item.loopVideo}" yeniden üretilsin mi? Var olan video değişir.`)) {
      return;
    }
    setConverting((files) => [...files, item.file]);
    setListError(null);
    setNotice(null);
    try {
      const res = await convertMimiImageToLoop(item.file, loopSeconds, regenerate);
      applyGallery(res);
      setNotice(`${res.file} üretildi (${res.seconds ?? loopSeconds} sn loop).`);
    } catch (error: unknown) {
      setListError(error instanceof Error ? error.message : 'Loop video üretilemedi.');
    } finally {
      setConverting((files) => files.filter((file) => file !== item.file));
    }
  };

  /** Video bekleyen bütün resimleri sırayla çevirir. */
  const handleConvertAll = async () => {
    const pending = items.filter((item) => item.needsVideo);
    if (pending.length === 0 || converting.length > 0) return;
    setListError(null);
    setNotice(null);
    const failed: string[] = [];
    let done = 0;
    for (const item of pending) {
      setConverting([item.file]);
      try {
        applyGallery(await convertMimiImageToLoop(item.file, loopSeconds));
        done += 1;
      } catch (error: unknown) {
        failed.push(`${item.file}: ${error instanceof Error ? error.message : 'çevrilemedi'}`);
      }
    }
    setConverting([]);
    setNotice(done > 0 ? `${done} resim ${loopSeconds} sn loop videoya çevrildi.` : null);
    if (failed.length > 0) setListError(failed.join(' · '));
  };

  const handleDelete = async (item: MimiAsset) => {
    if (busy) return;
    const extra = item.loopVideo ? ` (loop videosu "${item.loopVideo}" klasörde kalır)` : '';
    if (!window.confirm(`"${item.file}" silinsin mi? Geri Dönüşüm Kutusu'na gider${extra}.`)) return;
    setBusy(true);
    setListError(null);
    try {
      applyGallery(await deleteMimiAsset(item.file));
      if (openFile === item.file) setOpenFile(null);
    } catch (error: unknown) {
      setListError(error instanceof Error ? error.message : 'Dosya silinemedi.');
    } finally {
      setBusy(false);
    }
  };

  const handleOpenFolder = async () => {
    setListError(null);
    try {
      await openMimiFolder();
    } catch (error: unknown) {
      setListError(error instanceof Error ? error.message : 'Klasör açılamadı.');
    }
  };

  const imageCount = items.filter((item) => item.kind === 'image').length;
  const videoCount = items.length - imageCount;
  const pendingCount = items.filter((item) => item.needsVideo).length;
  const isConverting = converting.length > 0;

  return (
    <section className="page">
      <PageHeader
        eyebrow="GALERİ"
        title="Mimi"
        description={
          dir
            ? <>Üretip indirdiğin resim ve videolar burada duruyor. Klasör: <code>{dir}</code></>
            : 'Üretip indirdiğin resim ve videolar burada duruyor.'
        }
        actions={
          <>
            <button className="button" type="button" onClick={() => void handleOpenFolder()}>
              Klasörü Aç
            </button>
            <button className="button" type="button" disabled={busy || isConverting} onClick={() => void reload()}>
              Yenile
            </button>
            <button
              className="button button-primary"
              type="button"
              disabled={busy || isConverting}
              onClick={() => fileInputRef.current?.click()}
            >
              {busy ? 'Yükleniyor...' : 'Dosya Ekle'}
            </button>
          </>
        }
      />

      {/* Görünmez: yüklemeyi "Dosya Ekle" düğmesi açıyor. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={MIMI_ACCEPT}
        multiple
        style={{ display: 'none' }}
        onChange={(event) => void handleUpload(event.target.files)}
      />

      {folderError ? (
        <p className="notice notice-muted" role="alert">
          <strong>Mimi klasörü uyarısı</strong>
          <span>{folderError}</span>
        </p>
      ) : null}

      {/* Dönüşüm durumu tek bakışta: kaç resim hâlâ video bekliyor. */}
      {pendingCount > 0 ? (
        <p className="notice notice-muted mimi-pending-notice" role="status">
          <strong>Videoya çevrilecek</strong>
          <span>
            {pendingCount} resmin loop videosu yok. Kartlardaki şeritte
            {' '}<span className="mimi-chip is-missing">video yok</span>{' '}
            olarak görünürler.
          </span>
          <button
            className="button button-primary"
            type="button"
            disabled={isConverting || busy}
            onClick={() => void handleConvertAll()}
          >
            {isConverting ? 'Çevriliyor...' : `Hepsini çevir (${loopSeconds} sn)`}
          </button>
        </p>
      ) : null}

      {listError ? <p className="field-hint field-error" role="alert">{listError}</p> : null}
      {notice ? <p className="field-hint" role="status">{notice}</p> : null}

      <div className="toolbar">
        <input
          className="search-input"
          type="search"
          placeholder="Ara (dosya adı)"
          aria-label="Mimi galerisinde ara"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mimi-filters" role="group" aria-label="Tür süzgeci">
          {KIND_FILTERS.map((filter) => (
            <button
              key={filter.id}
              className={kind === filter.id ? 'button button-selected' : 'button'}
              type="button"
              aria-pressed={kind === filter.id}
              onClick={() => setKind(filter.id)}
            >
              {filter.label}
              {filter.id === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
            </button>
          ))}
        </div>
        <label className="mimi-seconds">
          Loop süresi
          <select
            value={loopSeconds}
            onChange={(event) => setLoopSeconds(Number(event.target.value))}
            disabled={isConverting}
          >
            {LOOP_SECONDS_CHOICES.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds} sn</option>
            ))}
          </select>
        </label>
        <span className="muted">
          {loadState === 'loading'
            ? 'Galeri yükleniyor...'
            : `${visible.length} dosya · ${imageCount} resim · ${videoCount} video · ${pendingCount} video bekliyor`}
        </span>
      </div>

      {items.length === 0 && loadState === 'loaded' ? (
        <EmptyState title="Galeri boş.">
          Üretip indirdiğin resim ve videoları "Dosya Ekle" ile yükle ya da "Klasörü Aç" ile
          doğrudan klasöre sürükle.
        </EmptyState>
      ) : visible.length === 0 && loadState === 'loaded' ? (
        <EmptyState
          title="Aramaya uyan dosya yok."
          action={
            <button className="button" type="button" onClick={() => { setQuery(''); setKind('all'); }}>
              Süzgeci temizle
            </button>
          }
        />
      ) : (
        <ul className="mimi-grid">
          {visible.map((item) => {
            const loop = item.loopVideo ? byFile.get(item.loopVideo) ?? null : null;
            const source = item.sourceImage ? byFile.get(item.sourceImage) ?? null : null;
            const isBusyItem = converting.includes(item.file)
              || (item.sourceImage !== null && converting.includes(item.sourceImage));
            return (
              <li key={item.file} className={`mimi-card role-${item.role}`}>
                <button
                  className="mimi-thumb"
                  type="button"
                  title="Büyük göster"
                  onClick={() => setOpenFile(item.file)}
                >
                  {item.kind === 'image' ? (
                    <img src={item.previewUrl} alt={item.name} loading="lazy" />
                  ) : (
                    // Metadata yeter: ilk kare poster olarak görünür, dosya indirilmez.
                    <video src={item.previewUrl} preload="metadata" muted playsInline />
                  )}
                  <span className={`mimi-kind kind-${item.role}`}>{ROLE_LABELS[item.role]}</span>
                  {item.needsVideo ? <span className="mimi-kind mimi-kind-right is-missing">VİDEO YOK</span> : null}
                </button>

                <div className="mimi-card-body">
                  <strong title={item.file}>{item.name}</strong>
                  <span className="muted">{formatSize(item.size)} · {formatDateTime(item.mtimeMs)}</span>
                </div>

                {/* Dönüşüm şeridi: resim → video yolunun neresinde olduğu. */}
                {item.role === 'video' ? null : (
                  <TransitionStrip
                    image={item.role === 'image' ? item : source}
                    video={item.role === 'image' ? loop : item}
                    converting={isBusyItem}
                    seconds={loopSeconds}
                    onOpen={setOpenFile}
                  />
                )}

                <div className="mimi-card-actions">
                  {item.kind === 'image' ? (
                    <button
                      className={item.needsVideo ? 'button button-primary' : 'button'}
                      type="button"
                      disabled={isBusyItem || busy}
                      title={item.needsVideo
                        ? `${loopSeconds} sn'lik loop video üret`
                        : `Loop videoyu ${loopSeconds} sn ile yeniden üret`}
                      onClick={() => void handleConvert(item)}
                    >
                      {isBusyItem ? 'Çevriliyor...' : item.needsVideo ? 'Videoya Çevir' : 'Yeniden Üret'}
                    </button>
                  ) : null}
                  <a className="button" href={item.previewUrl} download={item.file}>
                    İndir
                  </a>
                  <button
                    className="button project-delete"
                    type="button"
                    disabled={busy || isBusyItem}
                    title="Geri Dönüşüm Kutusu'na taşı"
                    onClick={() => void handleDelete(item)}
                  >
                    Sil
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {preview ? (
        <div
          className="mimi-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={preview.file}
          onClick={() => setOpenFile(null)}
        >
          {/* İçeriğe tıklamak kapatmasın — yalnızca dışına tıklamak kapatır. */}
          <div className="mimi-lightbox-inner" onClick={(event) => event.stopPropagation()}>
            <div className="mimi-lightbox-bar">
              <strong>{preview.file}</strong>
              <span className="muted">{formatSize(preview.size)}</span>
              {preview.loopVideo ? (
                <button className="button" type="button" onClick={() => setOpenFile(preview.loopVideo)}>
                  Loop videoyu göster
                </button>
              ) : null}
              {preview.sourceImage ? (
                <button className="button" type="button" onClick={() => setOpenFile(preview.sourceImage)}>
                  Kaynak resmi göster
                </button>
              ) : null}
              <a className="button" href={preview.previewUrl} download={preview.file}>İndir</a>
              <button className="button" type="button" onClick={() => setOpenFile(null)}>Kapat</button>
            </div>
            {preview.kind === 'image' ? (
              <img src={preview.previewUrl} alt={preview.name} />
            ) : (
              <video src={preview.previewUrl} controls autoPlay loop />
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

type TransitionStripProps = {
  image: MimiAsset | null;
  video: MimiAsset | null;
  converting: boolean;
  seconds: number;
  onOpen: (file: string) => void;
};

/**
 * "Resim → Video" geçiş şeridi.
 *
 * Üç durumu tek bakışta anlatır: solda kaynak resim, ortada ok (çevirirken
 * hareketli), sağda loop video — yoksa kesik çizgili boş kutu. Kaynak resim
 * silinmişse sol taraf "resim yok" olur; ikisi de tıklanabilir, büyük
 * önizlemeyi açar.
 */
function TransitionStrip({ image, video, converting, seconds, onOpen }: TransitionStripProps) {
  const status = converting
    ? `${seconds} sn loop üretiliyor...`
    : video
      ? 'Loop video hazır'
      : 'Videoya çevrilmesi gerekiyor';

  return (
    <div
      className={`mimi-transition${converting ? ' is-converting' : video ? ' is-ready' : ' is-missing'}`}
      aria-label={`Dönüşüm durumu: ${status}`}
    >
      <div className="mimi-transition-row">
        {image ? (
          <button
            className="mimi-transition-cell"
            type="button"
            title={image.file}
            onClick={() => onOpen(image.file)}
          >
            <img src={image.previewUrl} alt="" loading="lazy" />
            <span>resim</span>
          </button>
        ) : (
          <div className="mimi-transition-cell is-empty">
            <span className="mimi-transition-placeholder">—</span>
            <span>resim yok</span>
          </div>
        )}

        <span className="mimi-transition-arrow" aria-hidden="true">→</span>

        {video ? (
          <button
            className="mimi-transition-cell"
            type="button"
            title={video.file}
            onClick={() => onOpen(video.file)}
          >
            <video src={video.previewUrl} preload="metadata" muted playsInline />
            <span>loop video</span>
          </button>
        ) : (
          <div className={`mimi-transition-cell is-empty${converting ? ' is-working' : ''}`}>
            <span className="mimi-transition-placeholder">{converting ? '⏳' : '▶'}</span>
            <span>{converting ? 'üretiliyor' : 'video yok'}</span>
          </div>
        )}
      </div>
      <span className="mimi-transition-status">{status}</span>
    </div>
  );
}
