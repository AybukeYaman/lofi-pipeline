/** 3. adım — Müzik: Suno'dan aktarım, albüm, Ambiance ve Pomodoro seçimi. */
import { useEffect, useState } from 'react';
import {
  assignAlbumToProject,
  completeProjectMusic,
  copyProjectTracks,
  fetchMusicLibrary,
  fetchProject,
  ingestSunoToProject,
  openProjectFolder,
  uploadProjectAudio,
  fetchProjectMusic,
  ApiError,
} from '../../api';
import { EmptyState } from '../../components/Feedback';
import { AmbientPicker } from '../../components/AmbientPicker';
import { PomodoroPicker } from '../../components/PomodoroPicker';
import { PromptPicker } from '../../components/PromptPicker';
import { paths } from '../../router';
import { TrackList } from '../../components/TrackList';
import type { ProjectMusicInfo } from '../../types';
import { musicTracks } from './assetState';
import { UploadButton } from './StepWidgets';
import { StagePanel, type StageProps } from './StagePanel';

export function MusicStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const music = project.projectJson?.data?.music;
  const tracks = musicTracks(project);
  const readinessMusic = project.readiness?.music;
  const audioCount = readinessMusic ? readinessMusic.audioCount : (project.audioCount ?? 0);
  const trackCount = readinessMusic ? readinessMusic.trackCount : (music?.totalTracks ?? tracks.length);
  const completedCount = readinessMusic
    ? readinessMusic.completedTrackCount
    : (music?.completedCount ?? tracks.filter((t) => t.status === 'completed').length);

  const [isCompleting, setIsCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [completeSuccess, setCompleteSuccess] = useState<string | null>(null);

  // Inline Suno downloader state
  const [showSunoBox, setShowSunoBox] = useState(false);
  const [sunoUrl, setSunoUrl] = useState('');
  const [isIngestingSuno, setIsIngestingSuno] = useState(false);
  const [sunoIngestError, setSunoIngestError] = useState<string | null>(null);
  const [sunoIngestSuccess, setSunoIngestSuccess] = useState<string | null>(null);

  // Yüklenen dosyaların listesi (audioDir) — plan olmayan projede de adlar görünsün.
  const [musicInfo, setMusicInfo] = useState<ProjectMusicInfo | null>(null);
  useEffect(() => {
    let active = true;
    fetchProjectMusic(project.id)
      .then((info) => {
        if (active) setMusicInfo(info);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [project.id, audioCount]);

  // Album Library picker state
  const [showAlbumPicker, setShowAlbumPicker] = useState(false);
  const [libraryAlbums, setLibraryAlbums] = useState<Array<{ id: string; name: string; trackCount: number }>>([]);
  const [isImportingAlbum, setIsImportingAlbum] = useState(false);

  useEffect(() => {
    fetchMusicLibrary()
      .then((lib) => {
        setLibraryAlbums(lib.albums.map((a) => ({ id: a.id, name: a.name, trackCount: a.trackCount })));
      })
      .catch(() => {});
  }, []);

  const handleImportAlbum = async (albumId: string) => {
    setIsImportingAlbum(true);
    setCompleteError(null);
    setCompleteSuccess(null);
    try {
      const res = await assignAlbumToProject({ albumId, projectId: project.id });
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess(`✓ "${albumId}" albümünden ${res.copiedCount} parça projeye başarıyla aktarıldı.`);
      setShowAlbumPicker(false);
    } catch (err: unknown) {
      setCompleteError(err instanceof Error ? err.message : 'Albüm aktarılamadı.');
    } finally {
      setIsImportingAlbum(false);
    }
  };

  // Parent project music picker state
  const [showParentPicker, setShowParentPicker] = useState(false);
  const [parentAudioFiles, setParentAudioFiles] = useState<Array<{ file: string; duration: number | null; previewUrl: string | null }>>([]);
  const [selectedParentTracks, setSelectedParentTracks] = useState<string[]>([]);
  const [isLoadingParentTracks, setIsLoadingParentTracks] = useState(false);
  const [isCopyingFromParent, setIsCopyingFromParent] = useState(false);

  useEffect(() => {
    if (project.parentId && showParentPicker) {
      setIsLoadingParentTracks(true);
      fetchProjectMusic(project.parentId)
        .then((info) => {
          const files = info.audioFiles || [];
          setParentAudioFiles(files);
          const currentFileNames = new Set(musicInfo?.audioFiles.map((a) => a.file) || []);
          setSelectedParentTracks(files.filter((f) => !currentFileNames.has(f.file)).map((f) => f.file));
          setIsLoadingParentTracks(false);
        })
        .catch(() => {
          setIsLoadingParentTracks(false);
        });
    }
  }, [project.parentId, showParentPicker, musicInfo]);

  const handleCopyFromParent = async () => {
    if (!project.parentId || selectedParentTracks.length === 0 || isCopyingFromParent) return;
    setIsCopyingFromParent(true);
    setCompleteError(null);
    setCompleteSuccess(null);
    try {
      const res = await copyProjectTracks(project.id, {
        sourceProjectId: project.parentId,
        trackFiles: selectedParentTracks,
      });
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess(`✓ Ana proje "${project.parentId}"den ${res.copiedCount} parça bu projeye aktarıldı.`);
      setShowParentPicker(false);
    } catch (err: unknown) {
      setCompleteError(err instanceof Error ? err.message : 'Ana projeden müzik aktarılamadı.');
    } finally {
      setIsCopyingFromParent(false);
    }
  };

  const isMusicReady = readinessMusic?.ready ?? (assets.music === 'ready');
  const missingTracksCount = Math.max(0, trackCount - audioCount);

  const handleDownloadSuno = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sunoUrl.trim() || isIngestingSuno) return;
    setIsIngestingSuno(true);
    setSunoIngestError(null);
    setSunoIngestSuccess(null);
    try {
      const res = await ingestSunoToProject(project.id, sunoUrl.trim());
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setSunoIngestSuccess(`✓ ${res.downloadedCount} parça Suno'dan indirildi ve projeye bağlandı!`);
      setSunoUrl('');
    } catch (err: unknown) {
      setSunoIngestError(err instanceof Error ? err.message : 'Suno indirme başarısız oldu.');
    } finally {
      setIsIngestingSuno(false);
    }
  };

  const handleCompleteMusic = async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    setCompleteError(null);
    setCompleteSuccess(null);

    try {
      const updated = await completeProjectMusic(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess('Müzik adımı tamamlandı olarak işaretlendi.');
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setCompleteError(err.message);
      } else {
        setCompleteError(err instanceof Error ? err.message : 'Müzik adımı tamamlanamadı. Tekrar dene.');
      }
    } finally {
      setIsCompleting(false);
    }
  };

  const handleRefresh = async () => {
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
      setCompleteSuccess('Ses klasörü yeniden okundu.');
    } catch {
      setCompleteError('Parçalar okunamadı. Ses klasörünü kontrol edip tekrar dene.');
    }
  };

  const handleOpenFolder = async () => {
    try {
      await openProjectFolder(project.id, 'audio');
      setCompleteSuccess('audio/ klasörü Explorer’da açıldı.');
    } catch {
      setCompleteError('Klasör açılamadı. Proje klasörü taşınmış ya da silinmiş olabilir.');
    }
  };

  return (
    <StagePanel section="music" title="3. Müzik" status={assets.music} stageStatus={stageStatus}>
      {/* Kendi promptlarım — müzik üretmeye başlamadan önce kopyalanır. */}
      <PromptPicker
        tag="music"
        label="Kayıtlı promptlarım"
        onManage={() => { window.location.href = paths.prompts; }}
      />
      {/* Pomodoro burada: videonun kaç dakika olacağına karar veren ayar,
          müzik seçilirken bilinmeli — kullanıcı ne kadar parça gerektiğini
          parçaları eklemeden önce görsün. */}
      <PomodoroPicker projectId={project.id} />
      {/* Arka plan sesi — videonun tamamı boyunca döner. Montaja kadar
          değiştirilebilir; seçim project.json'daki `ambient` alanına yazılır. */}
      <AmbientPicker
        projectId={project.id}
        onManage={() => { window.location.href = paths.ambient; }}
      />
      <UploadButton
        label="Müzik dosyalarını yükle"
        accept=".mp3,.wav,.m4a,.flac,.aac,.opus,.ogg"
        multiple
        onFiles={async (files) => {
          let latest = project;
          for (const file of files) latest = await uploadProjectAudio(project.id, file);
          onProjectUpdate?.(latest);
        }}
      />
      <p className="field-hint">
        <strong>{audioCount} parça yüklendi.</strong>
      </p>
      <div className="music-summary">
        {music?.concept ? (
          <p>
            <span className="muted">Konsept</span> {music.concept}
          </p>
        ) : null}
        <p>
          <strong>{trackCount > 0 ? `${trackCount} parça planlandı` : `${audioCount} ses dosyası`}</strong>
          <span className="muted">
            {' '}
            · {audioCount} of {trackCount || audioCount} audio files present
            {trackCount > 0 && missingTracksCount > 0 ? ` (${missingTracksCount} remaining)` : ''}
            {completedCount > 0 ? ` · ${completedCount} tamamlandı olarak işaretli` : ''}
            {isMusicReady
              ? ' · Durum: Tamamlandı'
              : audioCount === 0
                ? ' · Durum: Ses dosyaları bekleniyor'
                : ' · Durum: Devam ediyor'}
          </span>
        </p>
      </div>

      {/* Suno Downloader Accordion / Box */}
      {showSunoBox ? (
        <div
          style={{
            margin: '12px 0 16px',
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🌐</span> Suno Linkinden Otomatik İndir (Suno Ingest)
            </strong>
            <button
              type="button"
              className="button"
              style={{ fontSize: 11, minHeight: 22, padding: '0 6px' }}
              onClick={() => setShowSunoBox(false)}
            >
              Kapat
            </button>
          </div>
          <form onSubmit={handleDownloadSuno} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="url"
                placeholder="https://suno.com/playlist/... veya https://suno.com/song/..."
                value={sunoUrl}
                onChange={(e) => setSunoUrl(e.target.value)}
                disabled={isIngestingSuno}
                style={{ flex: 1, fontSize: 13, padding: '6px 10px' }}
                required
              />
              <button
                type="submit"
                className="button button-primary"
                disabled={isIngestingSuno || !sunoUrl.trim()}
                style={{ fontSize: 13, minHeight: 32 }}
              >
                {isIngestingSuno ? 'İndiriliyor...' : 'İndir & Bağla'}
              </button>
            </div>
            {sunoIngestError ? (
              <p className="field-hint field-error" role="alert" style={{ margin: 0 }}>
                {sunoIngestError}
              </p>
            ) : null}
            {sunoIngestSuccess ? (
              <p className="field-hint" style={{ color: '#34603f', margin: 0, fontWeight: 600 }}>
                {sunoIngestSuccess}
              </p>
            ) : null}
          </form>
        </div>
      ) : null}

      {/* Album Library Picker Box */}
      {showAlbumPicker ? (
        <div
          style={{
            margin: '12px 0 16px',
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>📚</span> Müzik Kütüphanesinden Albüm Seç & Bu Projeye Aktar
            </strong>
            <button
              type="button"
              className="button"
              style={{ fontSize: 11, minHeight: 22, padding: '0 6px' }}
              onClick={() => setShowAlbumPicker(false)}
            >
              Kapat
            </button>
          </div>
          {libraryAlbums.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {libraryAlbums.map((album) => (
                <div
                  key={album.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: 6,
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  <div>
                    <strong style={{ fontSize: 13 }}>📁 {album.name}</strong>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 8 }}>
                      ({album.trackCount} parça)
                    </span>
                  </div>
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={isImportingAlbum || album.trackCount === 0}
                    style={{ fontSize: 12, minHeight: 26, padding: '2px 10px' }}
                    onClick={() => handleImportAlbum(album.id)}
                  >
                    {isImportingAlbum ? 'Aktarılıyor...' : 'Bu Albümü Projeye Aktar'}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="field-hint" style={{ margin: 0 }}>
              Kütüphanede henüz albüm yok. Albümler <code>music_library/</code> klasöründen okunuyor.
            </p>
          )}
        </div>
      ) : null}

      {/* Parent Project Music Picker Box */}
      {project.parentId && showParentPicker ? (
        <div
          style={{
            margin: '12px 0 16px',
            padding: '14px 16px',
            borderRadius: 8,
            background: 'var(--bg-surface-subtle)',
            border: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>📁</span> Ana Projeden Müzik Seç & Bu Projeye Aktar ({project.parentId})
            </strong>
            <button
              type="button"
              className="button"
              style={{ fontSize: 11, minHeight: 22, padding: '0 6px' }}
              onClick={() => setShowParentPicker(false)}
            >
              Kapat
            </button>
          </div>

          {isLoadingParentTracks ? (
            <p className="field-hint" style={{ margin: 0 }}>
              Ana projenin müzikleri yükleniyor...
            </p>
          ) : parentAudioFiles.length === 0 ? (
            <p className="field-hint" style={{ margin: 0 }}>
              Ana proje "{project.parentId}" içinde henüz ses dosyası bulunamadı.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {selectedParentTracks.length} / {parentAudioFiles.length} parça seçildi
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setSelectedParentTracks(parentAudioFiles.map((a) => a.file))}
                  >
                    Tümünü Seç
                  </button>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => setSelectedParentTracks([])}
                  >
                    Temizle
                  </button>
                </div>
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {parentAudioFiles.map((item) => {
                  const isChecked = selectedParentTracks.includes(item.file);
                  const isAlreadyInProject = musicInfo?.audioFiles.some((a) => a.file === item.file);
                  return (
                    <label
                      key={item.file}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '6px 10px',
                        borderRadius: 6,
                        background: 'var(--bg-surface)',
                        border: '1px solid var(--border-subtle)',
                        fontSize: 13,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedParentTracks((prev) => [...prev, item.file]);
                            } else {
                              setSelectedParentTracks((prev) => prev.filter((f) => f !== item.file));
                            }
                          }}
                        />
                        <span>{item.file}</span>
                        {isAlreadyInProject ? (
                          <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#efece4', color: '#685d4d' }}>
                            Mevcut
                          </span>
                        ) : null}
                      </div>
                      {item.previewUrl ? (
                        <audio
                          controls
                          src={item.previewUrl}
                          preload="none"
                          style={{ height: 24, width: 140 }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : null}
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className="button button-primary"
                disabled={isCopyingFromParent || selectedParentTracks.length === 0}
                style={{ alignSelf: 'flex-start', marginTop: 4 }}
                onClick={handleCopyFromParent}
              >
                {isCopyingFromParent ? 'Aktarılıyor...' : `Seçilen ${selectedParentTracks.length} Parçayı Aktar`}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {tracks.length > 0 ? (
        <TrackList tracks={tracks} />
      ) : musicInfo && musicInfo.audioFiles.length > 0 ? (
        <ol className="order-list">
          {musicInfo.audioFiles.map((audio, index) => (
            <li key={audio.file}>
              <span className="order-number">{index + 1}</span>
              <span className="order-name">{audio.file}</span>
            </li>
          ))}
        </ol>
      ) : audioCount > 0 ? (
        <EmptyState compact title="Parça adları okunamadı.">
          {audioCount} ses dosyası bulundu:{' '}
          <code
            onClick={handleOpenFolder}
            title="Explorer’da ses klasörünü aç"
            style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
          >
            {project.audioDir ?? 'ses klasörü'}
          </code>.
        </EmptyState>
      ) : (
        <EmptyState compact title="Henüz müzik parçası yok.">
          Suno ses dosyalarını (.mp3, .wav, .m4a, .flac) şu klasöre koy:{' '}
          <code
            onClick={handleOpenFolder}
            title="Explorer’da ses klasörünü aç"
            style={{ cursor: 'pointer', color: 'var(--primary)', textDecoration: 'underline' }}
          >
            {project.audioDir ?? 'ses klasörü'}
          </code>.
        </EmptyState>
      )}

      {completeError ? (
        <p className="field-hint field-error" role="alert" style={{ marginTop: 12 }}>
          {completeError}
        </p>
      ) : null}

      {completeSuccess ? (
        <p className="field-hint" style={{ color: '#34603f', marginTop: 12 }}>
          ✓ {completeSuccess}
        </p>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowAlbumPicker((prev) => !prev)}
        >
          📚 {showAlbumPicker ? 'Albümleri Gizle' : 'Kütüphaneden Albüm Seç'}
        </button>
        {project.parentId ? (
          <button
            className="button"
            type="button"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: '#faf6ee', borderColor: '#d3c5ae' }}
            onClick={() => setShowParentPicker((prev) => !prev)}
          >
            📁 {showParentPicker ? 'Ana Proje Müziklerini Gizle' : `Ana Projeden Müzik Aktar (${project.parentId})`}
          </button>
        ) : null}
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={() => setShowSunoBox((prev) => !prev)}
        >
          🌐 {showSunoBox ? 'Suno Alanını Gizle' : 'Suno Linkinden İndir'}
        </button>
        <button
          className="button"
          type="button"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
          onClick={handleOpenFolder}
        >
          📂 audio/ Klasörünü Aç
        </button>
        {!isMusicReady ? (
          <button
            className="button button-primary"
            type="button"
            disabled={isCompleting || audioCount === 0}
            onClick={handleCompleteMusic}
          >
            {isCompleting ? 'Müzik tamamlanıyor...' : 'Müziği Tamamla ve Devam Et'}
          </button>
        ) : null}
        <button
          className="button"
          type="button"
          disabled={isCompleting}
          onClick={handleRefresh}
        >
          🔄 Ses Dosyalarını Yenile
        </button>
      </div>

      {!isMusicReady && audioCount === 0 ? (
        <p className="field-hint" style={{ marginTop: 8 }}>
          ℹ Add at least 1 audio file (.mp3, .wav) to the audio folder, import an album, or download with Suno above to continue.
        </p>
      ) : null}
    </StagePanel>
  );
}
