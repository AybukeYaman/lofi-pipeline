import { useState } from 'react';

import { createShortsSubproject } from './api';
import { showError, showSuccess } from './toast';

/**
 * "Shorts alt projesi aç" işi — hem Projects kartından hem proje çalışma
 * ekranından aynı şekilde yapılıyor: uç çağrılır, oluşan proje açılır, hata
 * toast'a düşer. İki ekranda ayrı ayrı yazılmıştı ve hatayı farklı
 * gösteriyorlardı (biri toast, biri satır içi yazı); artık tek yer.
 *
 * `busyId` o an hangi projenin düğmesinin kilitli olduğunu söyler; kartta
 * birden çok düğme yan yana olduğu için kimlikle karşılaştırılır.
 */
export function useCreateShorts(onOpenProject?: (id: string) => void) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const createShorts = async (projectId: string) => {
    setBusyId(projectId);
    try {
      const shorts = await createShortsSubproject(projectId);
      showSuccess(`"${shorts.name}" açıldı — timeline'dan aralık seç.`, 'Shorts alt projesi');
      onOpenProject?.(shorts.id);
    } catch (error: unknown) {
      showError(error, 'Shorts alt projesi oluşturulamadı.');
    } finally {
      setBusyId(null);
    }
  };

  return { busyId, createShorts };
}
