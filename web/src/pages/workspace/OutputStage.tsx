/** 6. adım — Yayın: çıktı dosyası, tracklist ve açıklama metni. */
import { useState } from 'react';
import { fetchProject, getProjectOutputUrl, openProjectFolder } from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState } from '../../components/Feedback';
import { fileName } from './assetState';
import { CopyPrompt } from './StepWidgets';
import { StagePanel, type StageProps } from './StagePanel';

export function OutputStage({ project, assets, stageStatus, onProjectUpdate }: StageProps) {
  const outputName = fileName(project.output?.path);
  const tracklist = project.readiness?.output?.tracklist;
  const outputUrl = project.output?.exists && outputName ? getProjectOutputUrl(project.id, outputName) : null;
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefreshOutput = async () => {
    setIsRefreshing(true);
    try {
      const updated = await fetchProject(project.id);
      if (onProjectUpdate) {
        onProjectUpdate(updated);
      }
    } catch {
      // ignore
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <StagePanel section="publish" title="6. Yayın" status={assets.output} stageStatus={stageStatus}>
      {project.output?.exists ? (
        <div className="stage-media">
          <AssetPreview kind="video" fileName={outputName} src={outputUrl} emptyLabel="" />
          <div className="stage-actions">
            <dl className="readiness-list">
              <div>
                <dt>Çıktı</dt>
                <dd>{outputName}</dd>
              </div>
              <div>
                <dt>Ses dosyaları</dt>
                <dd>{project.audioCount ?? 0}</dd>
              </div>
              <div>
                <dt>Çıktı yolu</dt>
                <dd><code>{project.output?.path ?? 'out/final_ambient.mp4'}</code></dd>
              </div>
            </dl>

            <CopyPrompt
              label="Tracklist (YouTube açıklaması)"
              buttonLabel="Tracklist'i kopyala"
              prompt={tracklist?.text}
              error={tracklist?.exists ? 'Tracklist okunamadı.' : 'Tracklist dosyası bulunamadı — montajı yeniden başlat.'}
            />

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                type="button"
                className="button button-primary"
                onClick={() => openProjectFolder(project.id, 'out')}
              >
                📂 Çıktı Klasörünü Aç (Explorer)
              </button>
              {outputUrl ? (
                <a
                  href={outputUrl}
                  download={outputName || 'final_ambient.mp4'}
                  className="button"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                  ⬇️ İndir (MP4)
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div>
          <EmptyState compact title="Henüz çıktı yok.">
            The video will be assembled and written to <code>{outputName ?? 'out/final_ambient.mp4'}</code> when build completes.
          </EmptyState>
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className="button"
              disabled={isRefreshing}
              onClick={handleRefreshOutput}
            >
              {isRefreshing ? 'out/ kontrol ediliyor...' : '🔄 Çıktıyı Kontrol Et / Yenile'}
            </button>
          </div>
        </div>
      )}
    </StagePanel>
  );
}
