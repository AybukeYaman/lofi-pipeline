/**
 * Müzik klasöründeki zip'lerin açılma sonucunun kullanıcıya söylenecek metni
 * (sunucu `audioZip` alanını yalnızca zip işlenen yanıtta gönderir).
 */

import type { AudioZipResult } from './types';

export type AudioZipNotice = {
  /** Eklenen parça varsa tek cümle; yoksa null. */
  success: string | null;
  /** Açılamayan / müziksiz zip'ler için, her biri ayrı cümle. */
  problems: string[];
};

export function describeAudioZip(result: AudioZipResult): AudioZipNotice {
  const opened = result.archives.filter((archive) => archive.files.length > 0);
  const success = result.files.length > 0
    ? `${result.files.length} müzik parçası eklendi (${opened.map((archive) => archive.zip).join(', ')}).`
    : null;

  const problems = result.archives.flatMap((archive) => {
    if (archive.error) return [`${archive.zip} açılamadı: ${archive.error}`];
    if (archive.noAudio) return [`${archive.zip} içinde müzik dosyası yok.`];
    return [];
  });

  return { success, problems };
}
