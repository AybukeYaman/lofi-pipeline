import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addShortsClip,
  deleteShortsClip,
  fetchShorts,
  renderShortsClip,
  updateShortsClip,
} from '../api';
import { EmptyState } from '../components/Feedback';
import { errorText, formatSize } from '../format';
import { PageHeader } from '../components/PageHeader';
import {
  computeShortsCrop,
  DEFAULT_FRAME,
  formatTimecode,
  parseTimecode,
  type Frame,
} from '../shortsFrame';
import type { LoadState, ShortsClip, ShortsState } from '../types';
import { ShortsFramePicker, ShortsPreview } from './shorts/ShortsFrame';
import { ShortsTimeline } from './shorts/ShortsTimeline';

/** Render sürerken durumu bu aralıkla tazeliyoruz (ffmpeg ilerlemesi). */
const RENDER_POLL_MS = 1500;

/**
 * Shorts alt projesinin çalışma ekranı.
 *
 * Akış: videoyu aç → timeline'dan aralığı seç → 9:16 kadrajı ayarla →
 * "Bu Aralığı Al" → kesit listeye düşer → "Render" dendiğinde o aralık
 * 1080×1920 dosya olarak yazılır.
 *
 * Kaynak video kopyalanmaz; `<video>` ana projedeki dosyayı doğrudan akıtır
 * (`/api/projects/:id/shorts/source`). Kesitler yalnızca zaman aralığı +
 * kadraj kaydıdır, bu yüzden aralığı değiştirmek dosya üretmez.
 */
export function ShortsWorkspace({
  id,
  onBack,
}: {
  id: string;
  onBack: () => void;
}) {
  const [shorts, setShorts] = useState<ShortsState | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [range, setRange] = useState({ start: 0, end: 15 });
  const [frame, setFrame] = useState<Frame>({ ...DEFAULT_FRAME });
  const [currentTime, setCurrentTime] = useState(0);
  /** Düzenlenen kesit — "Bu Aralığı Al" yerine "Kesidi Güncelle" olur. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** Seçili aralığı oynatma: bitişte durdurmak için işaret. */
  const stopAt = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchShorts(id);
      setShorts(next);
      setLoadState('loaded');
      setLoadError(null);
      return next;
    } catch (error: unknown) {
      setLoadState('error');
      setLoadError(errorText(error, 'Shorts projesi yüklenemedi.'));
      return null;
    }
  }, [id]);

  useEffect(() => {
    setLoadState('loading');
    void load();
  }, [load]);

  // İlk yüklemede seçim videonun başından 15 sn (ya da video kısaysa tamamı).
  const duration = shorts?.source.duration ?? 0;
  const didInitRange = useRef(false);
  useEffect(() => {
    if (didInitRange.current || duration <= 0) return;
    didInitRange.current = true;
    setRange({ start: 0, end: Math.min(duration, 15) });
  }, [duration]);

  const running = useMemo(
    () => (shorts?.renders ?? []).filter((job) => job.state === 'running'),
    [shorts],
  );

  // Render sürerken durumu tazele: ilerleme ve "hazır" damgası kendiliğinden gelsin.
  useEffect(() => {
    if (running.length === 0) return undefined;
    const timer = window.setInterval(() => { void load(); }, RENDER_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running.length, load]);

  const source = shorts?.source;
  const limits = shorts?.limits ?? { minSeconds: 1, maxSeconds: 180, minZoom: 1, maxZoom: 4 };
  const selectionDuration = Math.max(0, range.end - range.start);
  const overLimit = selectionDuration > limits.maxSeconds;
  const tooShort = selectionDuration < limits.minSeconds;

  const crop = source?.width && source?.height
    ? computeShortsCrop(source.width, source.height, frame)
    : null;

  const seek = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrentTime(video.currentTime);
  };

  /** Seçili aralığı baştan oynatır ve bitişinde durur. */
  const playSelection = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = range.start;
    stopAt.current = range.end;
    void video.play().catch(() => {});
  };

  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(video.currentTime);
    if (stopAt.current !== null && video.currentTime >= stopAt.current) {
      video.pause();
      stopAt.current = null;
    }
  };

  const applyState = (next: ShortsState, message: string | null = null) => {
    setShorts(next);
    setNotice(message);
    setActionError(null);
  };

  /** "Bu Aralığı Al" / "Kesidi Güncelle". */
  const handleTake = async () => {
    if (busy || tooShort) return;
    setBusy(true);
    setActionError(null);
    try {
      const payload = { start: range.start, end: range.end, frame };
      if (editingId) {
        applyState(
          await updateShortsClip(id, editingId, payload),
          `${editingId} güncellendi — yeniden render gerekiyor.`,
        );
        setEditingId(null);
      } else {
        const next = await addShortsClip(id, payload);
        const added = next.clips.find((clip) => !shorts?.clips.some((old) => old.id === clip.id));
        applyState(next, `${added?.title ?? 'Kesit'} eklendi (${formatTimecode(selectionDuration)}).`);
      }
    } catch (error: unknown) {
      setActionError(errorText(error, 'Kesit kaydedilemedi.'));
    } finally {
      setBusy(false);
    }
  };

  /** Kesidi timeline'a geri yükler (düzenleme). */
  const handleEdit = (clip: ShortsClip) => {
    setEditingId(clip.id);
    setRange({ start: clip.start, end: clip.end });
    setFrame(clip.frame);
    seek(clip.start);
    setNotice(`${clip.title} düzenleniyor — aralığı değiştirip "Kesidi Güncelle" de.`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleRender = async (clip: ShortsClip) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await renderShortsClip(id, clip.id);
      await load();
      setNotice(`${clip.title} render ediliyor (${clip.durationLabel})...`);
    } catch (error: unknown) {
      setActionError(errorText(error, 'Render başlatılamadı.'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (clip: ShortsClip) => {
    if (busy) return;
    const extra = clip.rendered ? ` Render edilmiş dosya Geri Dönüşüm Kutusu'na gider.` : '';
    if (!window.confirm(`"${clip.title}" kesidi silinsin mi?${extra}`)) return;
    setBusy(true);
    setActionError(null);
    try {
      applyState(await deleteShortsClip(id, clip.id), `${clip.title} silindi.`);
      if (editingId === clip.id) setEditingId(null);
    } catch (error: unknown) {
      setActionError(errorText(error, 'Kesit silinemedi.'));
    } finally {
      setBusy(false);
    }
  };

  if (loadState === 'loading') {
    return <div className="state-card">Shorts projesi yükleniyor...</div>;
  }
  if (loadState === 'error' || !shorts || !source) {
    return (
      <div role="alert">
        <EmptyState
          title={loadError ?? 'Shorts projesi yüklenemedi.'}
          action={<button className="button" type="button" onClick={onBack}>Projelere dön</button>}
        />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={shorts.parentId ? `SHORTS ALT PROJESİ (ANA: ${shorts.parentId})` : 'SHORTS ALT PROJESİ'}
        title={shorts.name}
        description={
          source.exists
            ? <>Kaynak: <code>{source.name}</code> · {source.width}×{source.height}
              {source.fps ? ` · ${Math.round(source.fps)} fps` : ''} · {formatTimecode(source.duration ?? 0)}
              {source.hasAudio === false ? ' · sessiz' : ''} · hedef {shorts.target.aspect} ({shorts.target.width}×{shorts.target.height})</>
            : <>Kaynak video bulunamadı: <code>{source.value ?? '(tanımsız)'}</code></>
        }
        actions={
          /* Ana projeye dönüş üstteki sekme şeridinden (ProjectTabs) yapılıyor,
             burada ikinci bir düğme olarak tekrarlanmıyor. */
          <button className="button" type="button" disabled={busy} onClick={() => void load()}>
            🔄 Yenile
          </button>
        }
      />

      {shorts.problems.length > 0 ? (
        <p className="notice" role="alert">
          <strong>project.json</strong>
          <span>{shorts.problems.join(' · ')}</span>
        </p>
      ) : null}
      {shorts.warnings.length > 0 ? (
        <p className="notice notice-muted" role="status">
          <strong>Uyarı</strong>
          <span>{shorts.warnings.join(' · ')}</span>
        </p>
      ) : null}
      {actionError ? <p className="field-hint field-error" role="alert">{actionError}</p> : null}
      {notice ? <p className="field-hint" role="status">{notice}</p> : null}

      {!source.exists || !source.url || !source.width || !source.height ? (
        <EmptyState title="Kaynak video yok.">
          Alt proje ana projedeki videoya yol tutuyor ama dosya bulunamadı. Ana projede klibi
          yükle ya da montajı tamamla, sonra bu sayfayı yenile.
        </EmptyState>
      ) : (
        <>
          <section className="panel shorts-editor">
            <h2>1. Aralığı seç</h2>
            <div className="shorts-editor-grid">
              <div className="shorts-player">
                <video
                  ref={videoRef}
                  src={source.url}
                  controls
                  preload="metadata"
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleTimeUpdate}
                />
                <div className="shorts-player-actions">
                  <button className="button" type="button" onClick={playSelection}>
                    ▶ Seçimi oynat
                  </button>
                  <button
                    className="button"
                    type="button"
                    title="Başlangıcı oynatma konumuna al"
                    onClick={() => setRange((prev) => ({
                      start: Math.min(currentTime, prev.end - limits.minSeconds),
                      end: prev.end,
                    }))}
                  >
                    ⇤ Başlangıç = {formatTimecode(currentTime)}
                  </button>
                  <button
                    className="button"
                    type="button"
                    title="Bitişi oynatma konumuna al"
                    onClick={() => setRange((prev) => ({
                      start: prev.start,
                      end: Math.max(currentTime, prev.start + limits.minSeconds),
                    }))}
                  >
                    Bitiş = {formatTimecode(currentTime)} ⇥
                  </button>
                </div>
              </div>

              <div className="shorts-range-panel">
                <ShortsTimeline
                  duration={duration}
                  currentTime={currentTime}
                  start={range.start}
                  end={range.end}
                  minSeconds={limits.minSeconds}
                  onChange={setRange}
                  onSeek={seek}
                  sourceUrl={source.url}
                />

                <div className="shorts-time-fields">
                  <TimeField
                    label="Başlangıç"
                    value={range.start}
                    onCommit={(seconds) => setRange((prev) => ({
                      start: Math.min(Math.max(0, seconds), prev.end - limits.minSeconds),
                      end: prev.end,
                    }))}
                  />
                  <TimeField
                    label="Bitiş"
                    value={range.end}
                    onCommit={(seconds) => setRange((prev) => ({
                      start: prev.start,
                      end: Math.min(duration, Math.max(seconds, prev.start + limits.minSeconds)),
                    }))}
                  />
                  <div className="field">
                    <label>Kesit süresi</label>
                    <strong className={overLimit ? 'shorts-duration over' : 'shorts-duration'}>
                      {formatTimecode(selectionDuration)}
                    </strong>
                  </div>
                </div>

                {overLimit ? (
                  <p className="field-hint field-error">
                    {Math.round(selectionDuration)} sn — YouTube Shorts sınırı {limits.maxSeconds} sn.
                    Kesit yine oluşturulur ama Shorts olarak yayınlanmaz.
                  </p>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel shorts-editor">
            <h2>2. 9:16 kadrajı ayarla</h2>
            <div className="shorts-crop-grid">
              <ShortsFramePicker
                videoUrl={source.url}
                sourceWidth={source.width}
                sourceHeight={source.height}
                frame={frame}
                onChange={setFrame}
                previewTime={range.start}
              />
              {crop ? (
                <div className="shorts-crop-preview">
                  <span className="eyebrow">9:16 ÖNİZLEME</span>
                  <ShortsPreview
                    videoUrl={source.url}
                    sourceWidth={source.width}
                    sourceHeight={source.height}
                    crop={crop}
                    time={range.start}
                    range={range}
                    controls
                  />
                  <p className="field-hint">
                    Yalnızca kadrajın içi görünür — render böyle çıkar.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <div className="shorts-take-bar">
            <button
              className="button button-primary shorts-take"
              type="button"
              disabled={busy || tooShort}
              onClick={() => void handleTake()}
            >
              {editingId ? `✓ Kesidi Güncelle (${editingId})` : '✂ Bu Aralığı Al'}
            </button>
            <span className="muted">
              {formatTimecode(range.start)} → {formatTimecode(range.end)} · {formatTimecode(selectionDuration)}
              {tooShort ? ` · en az ${limits.minSeconds} sn seç` : ''}
            </span>
            {editingId ? (
              <button className="button" type="button" onClick={() => { setEditingId(null); setNotice(null); }}>
                Düzenlemeyi bırak
              </button>
            ) : null}
          </div>

          <section className="panel shorts-editor">
            <h2>3. Kesitler ({shorts.clips.length})</h2>
            {shorts.clips.length === 0 ? (
              <EmptyState title="Henüz kesit yok." compact>
                Timeline'dan bir aralık seç, kadrajı ayarla ve "Bu Aralığı Al" de. Aynı videodan
                istediğin kadar kesit alabilirsin.
              </EmptyState>
            ) : (
              <ul className="shorts-clip-grid">
                {shorts.clips.map((clip) => {
                  const job = shorts.renders.find((item) => item.clipId === clip.id);
                  const isRendering = job?.state === 'running';
                  const progress = isRendering && job.duration > 0
                    ? Math.min(100, Math.round((job.progressSeconds / job.duration) * 100))
                    : null;
                  return (
                    <li key={clip.id} className={`shorts-clip-card${editingId === clip.id ? ' is-editing' : ''}`}>
                      {clip.rendered && clip.videoUrl ? (
                        // Render edilmiş dosya zaten 9:16: kırpma dosyaya işlendi.
                        <ShortsPreview
                          videoUrl={clip.videoUrl}
                          sourceWidth={shorts.target.width}
                          sourceHeight={shorts.target.height}
                          crop={{ width: shorts.target.width, height: shorts.target.height, x: 0, y: 0 }}
                          controls
                        />
                      ) : source.url && clip.crop && source.width && source.height ? (
                        <ShortsPreview
                          videoUrl={source.url}
                          sourceWidth={source.width}
                          sourceHeight={source.height}
                          crop={clip.crop}
                          time={clip.start}
                          range={{ start: clip.start, end: clip.end }}
                        />
                      ) : null}

                      <div className="shorts-clip-body">
                        <strong>{clip.title}</strong>
                        <span className="muted">
                          {clip.startLabel} → {clip.endLabel} · {clip.durationLabel}
                        </span>
                        <span className="muted">
                          zoom {clip.frame.zoom.toFixed(2)}× · kadraj {Math.round(clip.frame.x * 100)}/
                          {Math.round(clip.frame.y * 100)}
                        </span>
                        <div className="shorts-clip-badges">
                          {isRendering ? (
                            <span className="status-badge status-processing">
                              Render {progress === null ? '' : `%${progress}`}
                            </span>
                          ) : clip.rendered ? (
                            <span className="status-badge status-ready">
                              Hazır{clip.outputSize ? ` · ${formatSize(clip.outputSize)}` : ''}
                            </span>
                          ) : job?.state === 'failed' ? (
                            <span className="status-badge status-failed">Render hatası</span>
                          ) : (
                            <span className="status-badge status-waiting">Render bekliyor</span>
                          )}
                          {clip.overLimit ? (
                            <span className="status-badge status-optional">{limits.maxSeconds} sn üstü</span>
                          ) : null}
                        </div>
                        {job?.state === 'failed' && job.error ? (
                          <span className="field-hint field-error">{job.error}</span>
                        ) : null}
                      </div>

                      <div className="shorts-clip-actions">
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={busy || isRendering || running.length > 0}
                          title={running.length > 0 && !isRendering ? 'Başka bir render sürüyor' : undefined}
                          onClick={() => void handleRender(clip)}
                        >
                          {isRendering ? 'Render...' : clip.rendered ? 'Yeniden Render' : 'Render (9:16)'}
                        </button>
                        <button className="button" type="button" disabled={busy} onClick={() => handleEdit(clip)}>
                          Düzenle
                        </button>
                        {clip.rendered && clip.videoUrl ? (
                          <a className="button" href={clip.videoUrl} download={clip.output}>İndir</a>
                        ) : null}
                        <button
                          className="button project-delete"
                          type="button"
                          disabled={busy || isRendering}
                          onClick={() => void handleDelete(clip)}
                        >
                          Sil
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="field-hint">
              Çıktı: <code>{shorts.outputDir}</code>
            </p>
          </section>
        </>
      )}
    </>
  );
}

/**
 * Elle zaman girişi. `mm:ss.s` ya da düz saniye kabul eder; anlaşılmayan
 * metin alanı kırmızıya çevirir ve değeri DEĞİŞTİRMEZ (yanlış yazım seçimi
 * bozmasın).
 */
function TimeField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (seconds: number) => void;
}) {
  const [text, setText] = useState(() => formatTimecode(value));
  const [invalid, setInvalid] = useState(false);
  const lastValue = useRef(value);

  // Timeline sürüklenirken alan da takip etsin (kullanıcı yazmıyorken).
  useEffect(() => {
    if (lastValue.current !== value) {
      lastValue.current = value;
      setText(formatTimecode(value));
      setInvalid(false);
    }
  }, [value]);

  const commit = () => {
    const seconds = parseTimecode(text);
    if (seconds === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    lastValue.current = seconds;
    onCommit(seconds);
  };

  return (
    <div className="field">
      <label>{label}</label>
      <input
        value={text}
        inputMode="decimal"
        aria-invalid={invalid}
        onChange={(event) => { setText(event.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? <span className="field-hint field-error">Biçim: 01:23.5 ya da 83.5</span> : null}
    </div>
  );
}
