/** 6. adım — Yayın: çıktı dosyası, tracklist ve açıklama metni. */
import { getProjectOutputUrl, openProjectFolder } from '../../api';
import { AssetPreview } from '../../components/AssetPreview';
import { EmptyState } from '../../components/Feedback';
import { fileName } from './assetState';
import { CopyPrompt } from './StepWidgets';
import { StagePanel, type StageProps } from './StagePanel';

export function OutputStage({ project, assets, stageStatus }: StageProps) {
  const outputName = fileName(project.output?.path);
  const tracklist = project.readiness?.output?.tracklist;
  const outputUrl = project.output?.exists && outputName ? getProjectOutputUrl(project.id, outputName) : null;

  return (
    <StagePanel section="publish" title="5. Yayın" status={assets.output} stageStatus={stageStatus}>
      {project.output?.exists ? (
        <div className="stage-media">
          <AssetPreview kind="video" fileName={outputName} src={outputUrl} emptyLabel="" />
          <div className="stage-actions">
            <dl className="readiness-list">
              <div>
                <dt>Video dosyası</dt>
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
        <EmptyState compact title="Henüz çıktı yok.">
          Montaj bitince video <code>{outputName ?? 'out/final_ambient.mp4'}</code> olarak buraya yazılır.
          Dışarıda bir şey değiştirdiysen aşağıdaki “Klasörü yeniden kontrol et” düğmesini kullan.
        </EmptyState>
      )}
    </StagePanel>
  );
}
