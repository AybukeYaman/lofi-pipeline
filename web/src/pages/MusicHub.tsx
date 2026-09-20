import { useEffect, useRef, useState } from 'react';

import {
  assignAlbumToProject,
  createMusicAlbum,
  deleteMusicAlbum,
  deleteMusicTrack,
  fetchMusicLibrary,
  ingestSuno,
  openMusicLibraryFolder,
  uploadMusicTrack,
  ApiError,
} from '../api';
import { EmptyState } from '../components/Feedback';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import type { MusicLibraryAlbum, MusicLibraryResponse, MusicLibraryTrack } from '../types';

export function MusicHub() {
  const [library, setLibrary] = useState<MusicLibraryResponse | null>(null);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New Album state
  const [newAlbumInput, setNewAlbumInput] = useState('');
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false);
  const [albumCreateError, setAlbumCreateError] = useState<string | null>(null);

  // Suno Downloader state
  const [sunoUrl, setSunoUrl] = useState('');
  const [sunoTargetType, setSunoTargetType] = useState<'new_album' | 'existing_album' | 'project'>('new_album');
  const [sunoTargetAlbumId, setSunoTargetAlbumId] = useState<string>('');
  const [sunoTargetProjectId, setSunoTargetProjectId] = useState<string>('');
  const [sunoNewAlbumName, setSunoNewAlbumName] = useState('');
  const [isIngesting, setIsIngesting] = useState(false);
  const [sunoError, setSunoError] = useState<string | null>(null);
  const [sunoSuccess, setSunoSuccess] = useState<string | null>(null);

  // Audio Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Drag and Drop (Sürükle-Bırak) State
  const [draggedItem, setDraggedItem] = useState<{ type: 'album' | 'track'; albumId: string; filename?: string } | null>(null);
  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null);
  const [dropToast, setDropToast] = useState<{ message: string; projectId: string } | null>(null);

  // Assign to project modal state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [assignProjectId, setAssignProjectId] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  // Currently playing audio preview
  const [playingTrack, setPlayingTrack] = useState<{ albumId: string; file: string } | null>(null);

  const loadData = async (preferredAlbumId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchMusicLibrary();
      setLibrary(data);
      if (data.albums.length > 0) {
        if (preferredAlbumId && data.albums.some((a) => a.id === preferredAlbumId)) {
          setSelectedAlbumId(preferredAlbumId);
        } else if (!selectedAlbumId || !data.albums.some((a) => a.id === selectedAlbumId)) {
          setSelectedAlbumId(data.albums[0].id);
        }
      } else {
        setSelectedAlbumId(null);
      }
      if (data.projects.length > 0 && !assignProjectId) {
        setAssignProjectId(data.projects[0].id);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Music library could not be loaded.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const selectedAlbum: MusicLibraryAlbum | undefined = library?.albums.find(
    (a) => a.id === selectedAlbumId,
  );

  const handleCreateAlbum = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAlbumInput.trim() || isCreatingAlbum) return;
    setIsCreatingAlbum(true);
    setAlbumCreateError(null);
    try {
      const created = await createMusicAlbum(newAlbumInput.trim());
      setNewAlbumInput('');
      await loadData(created.id);
    } catch (err: unknown) {
      setAlbumCreateError(err instanceof Error ? err.message : 'Could not create album.');
    } finally {
      setIsCreatingAlbum(false);
    }
  };

  const handleDeleteAlbum = async (albumId: string) => {
    if (!window.confirm(`"${albumId}" albümünü ve içindeki tüm ses dosyalarını silmek istediğinize emin misiniz?`)) {
      return;
    }
    try {
      await deleteMusicAlbum(albumId);
      await loadData();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Album could not be deleted.');
    }
  };

  const handleDeleteTrack = async (albumId: string, filename: string) => {
    if (!window.confirm(`"${filename}" parçasını silmek istediğinize emin misiniz?`)) {
      return;
    }
    try {
      await deleteMusicTrack(albumId, filename);
      await loadData(albumId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Track could not be deleted.');
    }
  };

  const handleOpenFolder = async (albumId?: string) => {
    try {
      await openMusicLibraryFolder(albumId);
    } catch {
      alert('Could not open folder in Explorer.');
    }
  };

  const handleUploadFiles = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0 || !selectedAlbumId) return;
    event.target.value = '';

    setIsUploading(true);
    setUploadError(null);

    try {
      for (const file of files) {
        await uploadMusicTrack(selectedAlbumId, file);
      }
      await loadData(selectedAlbumId);
    } catch (err: unknown) {
      setUploadError(err instanceof Error ? err.message : 'Failed to upload audio track.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleSunoDownload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sunoUrl.trim() || isIngesting) return;

    setIsIngesting(true);
    setSunoError(null);
    setSunoSuccess(null);

    try {
      let targetType: 'album' | 'project' = 'album';
      let targetId: string | undefined = undefined;
      let newAlbumName: string | undefined = undefined;

      if (sunoTargetType === 'new_album') {
        targetType = 'album';
        newAlbumName = sunoNewAlbumName.trim() || undefined;
        if (!newAlbumName) {
          throw new Error('Lütfen yeni albüm için bir isim girin.');
        }
      } else if (sunoTargetType === 'existing_album') {
        targetType = 'album';
        targetId = sunoTargetAlbumId || selectedAlbumId || undefined;
        if (!targetId) {
          throw new Error('Lütfen hedef albümü seçin.');
        }
      } else if (sunoTargetType === 'project') {
        targetType = 'project';
        targetId = sunoTargetProjectId || library?.projects[0]?.id;
        if (!targetId) {
          throw new Error('Lütfen hedef projeyi seçin.');
        }
      }

      const res = await ingestSuno({
        url: sunoUrl.trim(),
        targetType,
        targetId,
        newAlbumName,
      });

      setSunoSuccess(
        `✓ Başarılı! ${res.downloadedCount} parça indirildi (${
          res.targetType === 'album' ? `Albüm: ${res.albumId}` : `Proje: ${res.projectId}`
        }).`,
      );
      setSunoUrl('');
      setSunoNewAlbumName('');

      await loadData(res.albumId || selectedAlbumId || undefined);
    } catch (err: unknown) {
      setSunoError(err instanceof Error ? err.message : 'Suno indirme başarısız oldu.');
    } finally {
      setIsIngesting(false);
    }
  };

  const handleAssignToProject = async () => {
    if (!selectedAlbumId || !assignProjectId || isAssigning) return;
    setIsAssigning(true);
    setAssignError(null);
    setAssignSuccess(null);

    try {
      const res = await assignAlbumToProject({
        albumId: selectedAlbumId,
        projectId: assignProjectId,
      });
      setAssignSuccess(`✓ ${res.copiedCount} parça başarıyla "${assignProjectId}" projesine aktarıldı!`);
      setTimeout(() => {
        setShowAssignModal(false);
        setAssignSuccess(null);
      }, 1800);
    } catch (err: unknown) {
      setAssignError(err instanceof Error ? err.message : 'Parçalar projeye aktarılamadı.');
    } finally {
      setIsAssigning(false);
    }
  };

  // Drag & Drop Handler: Sürükleyip Projenin üzerine bırakma
  const handleDropOnProject = async (projectId: string) => {
    if (!draggedItem) return;
    setDragOverProjectId(null);

    try {
      const payload: { albumId: string; projectId: string; trackFiles?: string[] } = {
        albumId: draggedItem.albumId,
        projectId,
      };
      if (draggedItem.type === 'track' && draggedItem.filename) {
        payload.trackFiles = [draggedItem.filename];
      }

      const res = await assignAlbumToProject(payload);
      setDropToast({
        projectId,
        message:
          draggedItem.type === 'track'
            ? `✓ "${draggedItem.filename}" parçası "${projectId}" projesine eklendi!`
            : `✓ "${draggedItem.albumId}" albümü (${res.copiedCount} parça) "${projectId}" projesine aktarıldı!`,
      });

      setTimeout(() => {
        setDropToast(null);
      }, 3500);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Sürükle-bırak aktarımı başarısız oldu.');
    } finally {
      setDraggedItem(null);
    }
  };

  const totalTracks = library?.albums.reduce((sum, a) => sum + a.trackCount, 0) ?? 0;
  const totalDurationSec = library?.albums.reduce((sum, a) => sum + a.totalDuration, 0) ?? 0;
  const totalMins = Math.round(totalDurationSec / 60);

  return (
    <div className="page-container">
      <PageHeader
        title="Music Hub & Suno Downloader"
        description="Public Suno linklerinden müzik indirin, albüm klasörleri oluşturup düzenleyin veya albümleri kaydırarak doğrudan video projelerinin üzerine bırakın."
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="button"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => handleOpenFolder()}
          >
            📂 Open Library Folder
          </button>
          <button
            type="button"
            className="button"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            onClick={() => loadData(selectedAlbumId || undefined)}
          >
            🔄 Refresh
          </button>
        </div>
      </PageHeader>

      {/* Overview Stats */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOPLAM ALBÜM</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--text-main)' }}>
            {library?.albums.length ?? 0}
          </div>
        </div>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOPLAM PARÇA</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--text-main)' }}>
            {totalTracks}
          </div>
        </div>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>TOPLAM SÜRE</div>
          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: 'var(--text-main)' }}>
            {totalMins > 60
              ? `${Math.floor(totalMins / 60)} sa ${totalMins % 60} dk`
              : `${totalMins} dakika`}
          </div>
        </div>
        <div className="panel" style={{ padding: '14px 18px' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontWeight: 600 }}>KÜTÜPHANE YOLU</div>
          <div
            style={{
              fontSize: 12,
              fontFamily: 'monospace',
              marginTop: 6,
              color: 'var(--primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={library?.musicDir}
          >
            {library?.musicDir ?? 'music_library/'}
          </div>
        </div>
      </div>

      {/* Suno Downloader Panel */}
      <section className="panel" style={{ marginBottom: 20, borderLeft: '4px solid var(--primary)' }}>
        <header style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ fontSize: 18, margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>🌐</span> Suno Downloader (Otomatik Link İndirici)
            </h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Desteklenen: Song (<code>/song/...</code>), Playlist (<code>/playlist/...</code>), Kısa link (<code>/s/...</code>)
            </span>
          </div>
        </header>

        <form onSubmit={handleSunoDownload}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="field">
              <label htmlFor="suno-url-input" style={{ fontWeight: 600 }}>
                Public Suno Linki:
              </label>
              <input
                id="suno-url-input"
                type="url"
                placeholder="https://suno.com/playlist/7b2e... veya https://suno.com/song/..."
                value={sunoUrl}
                onChange={(e) => setSunoUrl(e.target.value)}
                disabled={isIngesting}
                style={{ width: '100%', fontSize: 14, padding: '10px 12px' }}
                required
              />
            </div>

            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', background: 'var(--bg-surface-subtle)', padding: '10px 14px', borderRadius: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Hedef Konum:</span>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="sunoTarget"
                  checked={sunoTargetType === 'new_album'}
                  onChange={() => setSunoTargetType('new_album')}
                  disabled={isIngesting}
                />
                <span>Yeni Albüm Klasörü</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="sunoTarget"
                  checked={sunoTargetType === 'existing_album'}
                  onChange={() => setSunoTargetType('existing_album')}
                  disabled={isIngesting || (library?.albums.length ?? 0) === 0}
                />
                <span>Mevcut Albüme Ekle</span>
              </label>

              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="radio"
                  name="sunoTarget"
                  checked={sunoTargetType === 'project'}
                  onChange={() => setSunoTargetType('project')}
                  disabled={isIngesting || (library?.projects.length ?? 0) === 0}
                />
                <span>Doğrudan Video Projesine Gönder</span>
              </label>
            </div>

            {sunoTargetType === 'new_album' ? (
              <div className="field" style={{ maxWidth: 400 }}>
                <label htmlFor="new-album-name-input">Yeni Albüm Adı:</label>
                <input
                  id="new-album-name-input"
                  type="text"
                  placeholder="örn. Cyberpunk Lo-Fi Night"
                  value={sunoNewAlbumName}
                  onChange={(e) => setSunoNewAlbumName(e.target.value)}
                  disabled={isIngesting}
                  required
                />
              </div>
            ) : sunoTargetType === 'existing_album' ? (
              <div className="field" style={{ maxWidth: 400 }}>
                <label htmlFor="existing-album-select">Hedef Albümü Seçin:</label>
                <select
                  id="existing-album-select"
                  value={sunoTargetAlbumId || selectedAlbumId || ''}
                  onChange={(e) => setSunoTargetAlbumId(e.target.value)}
                  disabled={isIngesting}
                >
                  {library?.albums.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.trackCount} parça)
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field" style={{ maxWidth: 400 }}>
                <label htmlFor="project-select">Hedef Projeyi Seçin:</label>
                <select
                  id="project-select"
                  value={sunoTargetProjectId || library?.projects[0]?.id || ''}
                  onChange={(e) => setSunoTargetProjectId(e.target.value)}
                  disabled={isIngesting}
                >
                  {library?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.step ? `(${p.step.title})` : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {sunoError ? (
              <p className="field-hint field-error" role="alert" style={{ margin: '4px 0' }}>
                {sunoError}
              </p>
            ) : null}

            {sunoSuccess ? (
              <p className="field-hint" style={{ color: '#34603f', fontWeight: 600, margin: '4px 0' }}>
                {sunoSuccess}
              </p>
            ) : null}

            <div style={{ marginTop: 4 }}>
              <button
                type="submit"
                className="button button-primary"
                disabled={isIngesting || !sunoUrl.trim()}
                style={{ padding: '10px 20px', fontSize: 14 }}
              >
                {isIngesting ? '⏳ Suno Şarkıları İndiriliyor...' : '📥 Suno\'dan İndir & Kaydet'}
              </button>
            </div>
          </div>
        </form>
      </section>

      {/* DRAG & DROP ZONE: Video Projeleri Hedef Paneli */}
      {library && library.projects.length > 0 ? (
        <section
          className="panel"
          style={{
            marginBottom: 20,
            background: draggedItem ? 'var(--primary-subtle)' : 'var(--bg-surface-subtle)',
            border: draggedItem ? '2px dashed var(--primary)' : '1px solid var(--border-subtle)',
            transition: 'all 0.2s ease',
            padding: '16px 20px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <strong style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-main)' }}>
                <span>🎯</span> Video Projelerine Sürükle & Bırak (Drag & Drop)
              </strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {draggedItem
                  ? '👇 Sürüklediğiniz albümü veya parçayı aşağıdaki video projelerinden birinin üzerine bırakın!'
                  : 'Sol taraftaki albümleri veya sağdaki parçaları tutup aşağıdaki projelerin üzerine sürükleyerek anında bağlayabilirsiniz.'}
              </span>
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 12,
              marginTop: 10,
            }}
          >
            {library.projects.map((proj) => {
              const isOver = dragOverProjectId === proj.id;
              const hasToast = dropToast?.projectId === proj.id;
              return (
                <div
                  key={proj.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragOverProjectId(proj.id);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    if (dragOverProjectId === proj.id) {
                      setDragOverProjectId(null);
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDropOnProject(proj.id);
                  }}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: isOver ? 'var(--primary-subtle)' : 'var(--bg-surface)',
                    border: isOver
                      ? '2px dashed var(--primary)'
                      : hasToast
                        ? '2px solid #34603f'
                        : '1px solid var(--border)',
                    boxShadow: isOver ? '0 4px 12px rgba(0,0,0,0.1)' : 'none',
                    transform: isOver ? 'scale(1.02)' : 'none',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    minHeight: 74,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <strong
                      style={{
                        fontSize: 13.5,
                        color: isOver ? 'var(--primary)' : 'var(--text-main)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      🎬 {proj.name}
                    </strong>
                    {proj.step?.title ? (
                      <span
                        style={{
                          fontSize: 11,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'var(--bg-surface-subtle)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        {proj.step.title}
                      </span>
                    ) : null}
                  </div>

                  <div style={{ marginTop: 8, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    {isOver ? (
                      <strong style={{ color: 'var(--primary)', fontSize: 12 }}>
                        📥 Buraya Bırak (Aktar)
                      </strong>
                    ) : hasToast ? (
                      <span style={{ color: '#34603f', fontWeight: 600, fontSize: 11.5 }}>
                        {dropToast.message}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>
                        Albümü buraya sürükleyin
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Main Album Explorer (Original Folder Layout) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: 20,
          alignItems: 'start',
        }}
      >
        {/* Left: Album Navigation List */}
        <aside className="panel" style={{ padding: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>Albümler</h3>
            <span className="count">({library?.albums.length ?? 0})</span>
          </div>

          <form onSubmit={handleCreateAlbum} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                placeholder="Yeni albüm adı..."
                value={newAlbumInput}
                onChange={(e) => setNewAlbumInput(e.target.value)}
                disabled={isCreatingAlbum}
                style={{ fontSize: 12.5, minHeight: 32, padding: '4px 8px', flex: 1 }}
              />
              <button
                type="submit"
                className="button"
                disabled={isCreatingAlbum || !newAlbumInput.trim()}
                style={{ fontSize: 12, minHeight: 32, padding: '0 10px' }}
              >
                {isCreatingAlbum ? '...' : '➕'}
              </button>
            </div>
            {albumCreateError ? (
              <p className="field-hint field-error" style={{ fontSize: 11, marginTop: 4 }}>
                {albumCreateError}
              </p>
            ) : null}
          </form>

          {library && library.albums.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {library.albums.map((album) => {
                const isSelected = album.id === selectedAlbumId;
                const isDraggingThis = draggedItem?.type === 'album' && draggedItem?.albumId === album.id;
                return (
                  <li key={album.id}>
                    <div
                      draggable={true}
                      onDragStart={(e) => {
                        setDraggedItem({ type: 'album', albumId: album.id });
                        e.dataTransfer.setData('text/plain', album.id);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onDragEnd={() => {
                        setDraggedItem(null);
                        setDragOverProjectId(null);
                      }}
                      onClick={() => setSelectedAlbumId(album.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 6,
                        border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border-subtle)',
                        background: isSelected ? 'var(--primary-subtle)' : 'var(--bg-surface)',
                        cursor: 'grab',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        opacity: isDraggingThis ? 0.4 : 1,
                        boxShadow: isDraggingThis ? '0 4px 10px rgba(0,0,0,0.15)' : 'none',
                        transition: 'all 0.1s ease',
                      }}
                      title="Tıklayarak seçin veya tutup yukarıdaki videolara sürükleyin"
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <strong
                          style={{
                            fontSize: 13.5,
                            color: isSelected ? 'var(--primary)' : 'var(--text-main)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span style={{ color: 'var(--text-muted)', cursor: 'grab' }}>⋮⋮</span> 📁 {album.name}
                        </strong>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
                        <span>{album.trackCount} parça</span>
                        {album.totalDurationFormatted !== '0:00' ? <span>· {album.totalDurationFormatted}</span> : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState compact title="Henüz albüm yok.">
              Yeni bir albüm oluşturun veya Suno'dan indirin.
            </EmptyState>
          )}
        </aside>

        {/* Right: Selected Album Detail & Tracks */}
        <main className="panel" style={{ padding: '20px' }}>
          {selectedAlbum ? (
            <div>
              {/* Album Header & Actions */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: 12,
                  paddingBottom: 16,
                  borderBottom: '1px solid var(--border)',
                  marginBottom: 16,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h2 style={{ fontSize: 20, margin: 0 }}>📁 {selectedAlbum.name}</h2>
                    <StatusBadge status="ready" label={`${selectedAlbum.trackCount} parça`} />
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4, display: 'flex', gap: 12 }}>
                    <span>Toplam Süre: <strong>{selectedAlbum.totalDurationFormatted}</strong></span>
                    <span>Boyut: <strong>{(selectedAlbum.totalSize / (1024 * 1024)).toFixed(1)} MB</strong></span>
                    <span>Klasör: <code>{selectedAlbum.path}</code></span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12.5 }}
                    onClick={() => handleOpenFolder(selectedAlbum.id)}
                  >
                    📂 Klasörü Aç
                  </button>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12.5 }}
                    disabled={isUploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {isUploading ? 'Yükleniyor...' : '➕ Ses Yükle'}
                  </button>
                  <button
                    type="button"
                    className="button button-primary"
                    style={{ fontSize: 12.5 }}
                    disabled={selectedAlbum.trackCount === 0}
                    onClick={() => setShowAssignModal(true)}
                  >
                    🚀 Projeye Aktar
                  </button>
                  <button
                    type="button"
                    className="button"
                    style={{ fontSize: 12.5, color: '#b91c1c' }}
                    onClick={() => handleDeleteAlbum(selectedAlbum.id)}
                  >
                    🗑️ Albümü Sil
                  </button>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".mp3,.m4a,.wav,.flac,.aac,.ogg,.opus"
                  multiple
                  className="visually-hidden"
                  onChange={handleUploadFiles}
                />
              </div>

              {uploadError ? (
                <p className="field-hint field-error" role="alert" style={{ marginBottom: 12 }}>
                  {uploadError}
                </p>
              ) : null}

              {/* Tracks Table (Also Draggable!) */}
              {selectedAlbum.tracks.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '8px 10px', width: 40 }}>#</th>
                        <th style={{ padding: '8px 10px' }}>Parça Başlığı / Dosya</th>
                        <th style={{ padding: '8px 10px', width: 180 }}>Önizleme (Çal)</th>
                        <th style={{ padding: '8px 10px', width: 90 }}>Süre</th>
                        <th style={{ padding: '8px 10px', width: 80 }}>Boyut</th>
                        <th style={{ padding: '8px 10px', width: 50 }}>İşlem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedAlbum.tracks.map((track, index) => {
                        const isPlaying =
                          playingTrack?.albumId === selectedAlbum.id && playingTrack?.file === track.file;
                        const isDraggingTrack =
                          draggedItem?.type === 'track' &&
                          draggedItem?.albumId === selectedAlbum.id &&
                          draggedItem?.filename === track.file;
                        return (
                          <tr
                            key={track.file}
                            draggable={true}
                            onDragStart={(e) => {
                              setDraggedItem({ type: 'track', albumId: selectedAlbum.id, filename: track.file });
                              e.dataTransfer.setData('text/plain', track.file);
                              e.dataTransfer.effectAllowed = 'copy';
                            }}
                            onDragEnd={() => {
                              setDraggedItem(null);
                              setDragOverProjectId(null);
                            }}
                            style={{
                              borderBottom: '1px solid var(--border-subtle)',
                              background: isPlaying ? 'var(--bg-surface-subtle)' : undefined,
                              opacity: isDraggingTrack ? 0.4 : 1,
                              cursor: 'grab',
                            }}
                            title="Bu parçayı tutup yukarıdaki video projelerinden birine sürükleyebilirsiniz"
                          >
                            <td style={{ padding: '10px', color: 'var(--text-muted)' }}>
                              <span style={{ cursor: 'grab', marginRight: 4 }}>⋮⋮</span>
                              {String(index + 1).padStart(2, '0')}
                            </td>
                            <td style={{ padding: '10px' }}>
                              <strong style={{ color: 'var(--text-main)' }}>{track.name}</strong>
                              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
                                {track.file}
                              </div>
                            </td>
                            <td style={{ padding: '10px' }}>
                              <audio
                                controls
                                preload="none"
                                src={track.previewUrl}
                                style={{ width: 170, height: 32 }}
                                onPlay={() => setPlayingTrack({ albumId: selectedAlbum.id, file: track.file })}
                              />
                            </td>
                            <td style={{ padding: '10px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                              {track.durationFormatted || '--:--'}
                            </td>
                            <td style={{ padding: '10px', color: 'var(--text-muted)' }}>
                              {(track.size / (1024 * 1024)).toFixed(1)} MB
                            </td>
                            <td style={{ padding: '10px' }}>
                              <button
                                type="button"
                                aria-label="Delete track"
                                title="Parçayı Sil"
                                onClick={() => handleDeleteTrack(selectedAlbum.id, track.file)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  color: 'var(--text-muted)',
                                  fontSize: 16,
                                }}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState compact title="Bu albümde henüz parça yok.">
                  Yukarıdaki <strong>"➕ Ses Yükle"</strong> butonu ile dosya ekleyebilir veya Suno Downloader ile parça indirebilirsiniz.
                </EmptyState>
              )}
            </div>
          ) : (
            <EmptyState title="Bir albüm seçin veya yeni oluşturun." />
          )}
        </main>
      </div>

      {/* Assign to Project Modal */}
      {showAssignModal && selectedAlbum ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 16,
          }}
          onClick={() => setShowAssignModal(false)}
        >
          <div
            className="panel"
            style={{ maxWidth: 460, width: '100%', padding: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ marginTop: 0, fontSize: 18 }}>
              🚀 Projeye Parça Aktar
            </h3>
            <p className="field-hint" style={{ margin: '8px 0 16px' }}>
              <strong>"{selectedAlbum.name}"</strong> albümündeki {selectedAlbum.trackCount} parça seçilen projenin <code>audio/</code> klasörüne kopyalanacak ve parça planı güncellenecektir.
            </p>

            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="assign-project-select" style={{ fontWeight: 600 }}>
                Hedef Proje:
              </label>
              <select
                id="assign-project-select"
                value={assignProjectId}
                onChange={(e) => setAssignProjectId(e.target.value)}
                disabled={isAssigning}
                style={{ width: '100%' }}
              >
                {library?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {assignError ? (
              <p className="field-hint field-error" role="alert" style={{ marginBottom: 12 }}>
                {assignError}
              </p>
            ) : null}

            {assignSuccess ? (
              <p className="field-hint" style={{ color: '#34603f', fontWeight: 600, marginBottom: 12 }}>
                {assignSuccess}
              </p>
            ) : null}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
              <button
                type="button"
                className="button"
                disabled={isAssigning}
                onClick={() => setShowAssignModal(false)}
              >
                İptal
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={isAssigning || !assignProjectId}
                onClick={handleAssignToProject}
              >
                {isAssigning ? 'Aktarılıyor...' : 'Aktarımı Başlat'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
