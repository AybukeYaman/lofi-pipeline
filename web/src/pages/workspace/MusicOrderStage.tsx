/**
 * 3. adım — Müzik ve sıralama. Sunucuda iki ayrı adım (`music`, `order`) olarak
 * duran işler ekranda tek çerçevede: önce parçaları getir, aşağıda sırala.
 */
import type { AssetStatus } from '../../components/StatusBadge';
import { MusicSection } from './MusicStage';
import { OrderSection } from './CanonicalStages';
import { StagePanel, type StageProps } from './StagePanel';
import { stepInfo, MUSIC_STEP_TITLE } from '../../workflow';

export function MusicOrderStage(props: StageProps) {
  const { project, assets, stageStatus } = props;

  const orderSaved = (project.projectJson?.data?.order?.length ?? 0) > 0;
  // Sunucudaki `order` adımının kendi durumu: kayıt bitince adım tamamlanır.
  const orderDone = stepInfo(project.workflow, 'order')?.status === 'done';
  const musicReady = project.readiness?.music?.ready ?? assets.music === 'ready';

  // Başlık rozeti: müzik hazır değilse onun durumu, hazırsa sıranın durumu.
  const status: AssetStatus = !musicReady ? assets.music : orderSaved ? 'ready' : 'waiting';
  const statusLabel = !musicReady ? undefined : orderSaved ? 'Sıra kaydedildi' : 'Sıra bekleniyor';

  return (
    <StagePanel section="music" title={`3. ${MUSIC_STEP_TITLE}`} status={status} statusLabel={statusLabel} stageStatus={stageStatus}>
      <MusicSection {...props} />
      <section className="stage-subsection" aria-labelledby="stage-order-title">
        <h3 id="stage-order-title">Sıralama</h3>
        {/* Tek vurgulu eylem: müzik bitmeden "Müziği tamamla", bitince "Sıralamayı kaydet". */}
        <OrderSection {...props} primary={musicReady && !orderDone} />
      </section>
    </StagePanel>
  );
}
