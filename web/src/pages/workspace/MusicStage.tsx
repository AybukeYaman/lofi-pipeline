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
      <div className="picker-group">
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
      </div>
      <UploadButton
        label="Müzik dosyalarını yükle"
        accept=".mp3,.wav,.m4a,.flac,.aac,.opus,.ogg"
        primary={audioCount === 0}
        multiple
        onFiles={async (files) => {
          let latest = project;
          for (const file of files) latest = await uploadProjectAudio(project.id, file);
          onProjectUpdate?.(latest);
        }}
      />
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
            {trackCount > 0 ? ` · ${audioCount} / ${trackCount} ses dosyası hazır` : ''}
            {trackCount > 0 && missingTracksCount > 0 ? ` (${missingTracksCount} eksik)` : ''}
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
        <div className="tool-box">
          <div className="tool-box-head">
            <strong className="tool-box-title">Suno linkinden otomatik indir</strong>
            <button type="button" className="button button-compact" onClick={() => setShowSunoBox(false)}>
              Kapat
            </button>
          </div>
          <form onSubmit={handleDownloadSuno} className="tool-box-body">
            <div className="tool-box-row">
              <input
                type="url"
                className="tool-box-input"
                placeholder="https://suno.com/playlist/... veya https://suno.com/song/..."
                value={sunoUrl}
                onChange={(e) => setSunoUrl(e.target.value)}
                disabled={isIngestingSuno}
                required
              />
              <button
                type="submit"
                className="button button-primary"
                disabled={isIngestingSuno || !sunoUrl.trim()}
              >
                {isIngestingSuno ? 'İndiriliyor...' : 'İndir ve bağla'}
              </button>
            </div>
            {sunoIngestError ? (
              <p className="field-hint field-error" role="alert">
                {sunoIngestError}
              </p>
            ) : null}
            {sunoIngestSuccess ? <p className="field-hint field-success">{sunoIngestSuccess}</p> : null}
          </form>
        </div>
      ) : null}

      {/* Album Library Picker Box */}
      {showAlbumPicker ? (
        <div className="tool-box">
          <div className="tool-box-head">
            <strong className="tool-box-title">Kütüphaneden albüm seç ve bu projeye aktar</strong>
            <button type="button" className="button button-compact" onClick={() => setShowAlbumPicker(false)}>
              Kapat
            </button>
          </div>
          {libraryAlbums.length > 0 ? (
            <ul className="tool-list">
              {libraryAlbums.map((album) => (
                <li key={album.id}>
                  <div>
                    <strong>{album.name}</strong>
                    <span className="muted"> · {album.trackCount} parça</span>
                  </div>
                  <button
                    type="button"
                    className="button button-primary button-compact"
                    disabled={isImportingAlbum || album.trackCount === 0}
                    onClick={() => handleImportAlbum(album.id)}
                  >
                    {isImportingAlbum ? 'Aktarılıyor...' : 'Bu albümü projeye aktar'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">
              Kütüphanede henüz albüm yok. Albümler <code>music_library/</code> klasöründen okunuyor.
            </p>
          )}
        </div>
      ) : null}

      {/* Parent Project Music Picker Box */}
      {project.parentId && showParentPicker ? (
        <div className="tool-box">
          <div className="tool-box-head">
            <strong className="tool-box-title">Ana projeden müzik seç ve bu projeye aktar ({project.parentId})</strong>
            <button type="button" className="button button-compact" onClick={() => setShowParentPicker(false)}>
              Kapat
            </button>
          </div>

          {isLoadingParentTracks ? (
            <p className="field-hint">Ana projenin müzikleri yükleniyor...</p>
          ) : parentAudioFiles.length === 0 ? (
            <p className="field-hint">Ana proje "{project.parentId}" içinde henüz ses dosyası bulunamadı.</p>
          ) : (
            <div className="tool-box-body">
              <div className="tool-box-row tool-box-row-between">
                <span className="muted">
                  {selectedParentTracks.length} / {parentAudioFiles.length} parça seçildi
                </span>
                <div className="tool-box-row">
                  <button
                    type="button"
                    className="button button-compact"
                    onClick={() => setSelectedParentTracks(parentAudioFiles.map((a) => a.file))}
                  >
                    Tümünü seç
                  </button>
                  <button type="button" className="button button-compact" onClick={() => setSelectedParentTracks([])}>
                    Temizle
                  </button>
                </div>
              </div>
              <ul className="tool-list tool-list-scroll">
                {parentAudioFiles.map((item) => {
                  const isChecked = selectedParentTracks.includes(item.file);
                  const isAlreadyInProject = musicInfo?.audioFiles.some((a) => a.file === item.file);
                  return (
                    <li key={item.file}>
                      <label className="tool-check">
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
                        {isAlreadyInProject ? <span className="tag">Mevcut</span> : null}
                      </label>
                      {item.previewUrl ? (
                        <audio controls src={item.previewUrl} preload="none" className="tool-audio" />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                className="button button-primary tool-box-submit"
                disabled={isCopyingFromParent || selectedParentTracks.length === 0}
                onClick={handleCopyFromParent}
              >
                {isCopyingFromParent ? 'Aktarılıyor...' : `Seçilen ${selectedParentTracks.length} parçayı aktar`}
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
          <code className="link-code" onClick={handleOpenFolder} title="Explorer’da ses klasörünü aç">
            {project.audioDir ?? 'ses klasörü'}
          </code>.
        </EmptyState>
      ) : (
        <EmptyState compact title="Henüz müzik parçası yok.">
          Suno ses dosyalarını (.mp3, .wav, .m4a, .flac) şu klasöre koy:{' '}
          <code className="link-code" onClick={handleOpenFolder} title="Explorer’da ses klasörünü aç">
            {project.audioDir ?? 'ses klasörü'}
          </code>.
        </EmptyState>
      )}

      {completeError ? (
        <p className="field-hint field-error" role="alert">
          {completeError}
        </p>
      ) : null}

      {completeSuccess ? <p className="field-hint field-success">✓ {completeSuccess}</p> : null}

      <div className="stage-actions-row">
        <button className="button" type="button" onClick={() => setShowAlbumPicker((prev) => !prev)}>
          {showAlbumPicker ? 'Albümleri gizle' : 'Kütüphaneden albüm seç'}
        </button>
        {project.parentId ? (
          <button className="button" type="button" onClick={() => setShowParentPicker((prev) => !prev)}>
            {showParentPicker ? 'Ana proje müziklerini gizle' : `Ana projeden müzik aktar (${project.parentId})`}
          </button>
        ) : null}
        <button className="button" type="button" onClick={() => setShowSunoBox((prev) => !prev)}>
          {showSunoBox ? 'Suno alanını gizle' : 'Suno linkinden indir'}
        </button>
        <button className="button" type="button" onClick={handleOpenFolder}>
          audio/ klasörünü aç
        </button>
        <button className="button" type="button" disabled={isCompleting} onClick={handleRefresh}>
          Ses dosyalarını yenile
        </button>
        {!isMusicReady ? (
          <button
            className={audioCount > 0 ? 'button button-primary' : 'button'}
            type="button"
            disabled={isCompleting || audioCount === 0}
            onClick={handleCompleteMusic}
          >
            {isCompleting ? 'Müzik tamamlanıyor...' : 'Müziği tamamla ve devam et'}
          </button>
        ) : null}
      </div>

      {!isMusicReady && audioCount === 0 ? (
        <p className="field-hint">
          ℹ Devam etmek için ses klasörüne en az 1 dosya (.mp3, .wav) ekle, bir albüm aktar ya da yukarıdan Suno linkiyle indir.
        </p>
      ) : null}
    </StagePanel>
  );
}
