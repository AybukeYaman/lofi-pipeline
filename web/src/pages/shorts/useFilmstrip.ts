import { useEffect, useState } from 'react';

/**
 * Timeline'ın arkasındaki film şeridi — CapCut'ta videonun kareleri olarak
 * görünen şerit.
 *
 * Kareler TARAYICIDA üretilir: gizli bir `<video>` tek tek saniyelere sarılır
 * ve her duruşta kare bir `<canvas>`a çizilip data URL'e çevrilir. Sunucuya
 * yeni bir uç ya da ffmpeg çağrısı eklenmiyor — kaynak akışı (`…/shorts/source`)
 * Range isteklerini zaten destekliyor, ileri sarma onunla oluyor.
 *
 * Kareler SIRAYLA alınır: aynı `<video>` üzerinde tek bir `seeked` beklenir,
 * paralel sarma elementin durumunu karıştırır. Şerit dolarken timeline
 * kullanılabilir durumda kalsın diye her kare geldiğinde durum güncellenir
 * (soldan sağa dolar).
 */

/** Kare yüksekliği (px) — şerit yüksekliğiyle aynı, genişlik orandan çıkar. */
const FRAME_HEIGHT = 48;

export type FilmstripFrame = { seconds: number; url: string };

export type FilmstripState = {
  frames: FilmstripFrame[];
  /** Hepsi geldi mi — şerit dolarken "hazırlanıyor" yazısı için. */
  done: boolean;
  /** Kare alınamadıysa (codec/çizim engeli): şerit yerine düz zemin. */
  failed: boolean;
};

const EMPTY: FilmstripState = { frames: [], done: false, failed: false };

/**
 * @param url kaynak video adresi (boşsa şerit üretilmez)
 * @param duration video süresi — kare konumları buna göre bölünür
 * @param count kaç kare alınsın (timeline genişliğine göre çağıran seçer)
 */
export function useFilmstrip(url: string | null, duration: number, count: number): FilmstripState {
  const [state, setState] = useState<FilmstripState>(EMPTY);

  useEffect(() => {
    if (!url || !(duration > 0) || count <= 0) {
      setState(EMPTY);
      return undefined;
    }

    // Etkinin iptali: url/süre değişirse yarıda kalan şerit yazılmasın.
    let cancelled = false;
    setState(EMPTY);

    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    // Mobil tarayıcılar tam ekrana geçmesin, kare çizimi bozulur.
    video.playsInline = true;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    /** Kareyi ortasından değil, aralığın BAŞINDAN alıyoruz: cetvelle hizalı. */
    const secondsFor = (index: number) => (duration * index) / count;

    const seekTo = (seconds: number) =>
      new Promise<void>((resolve, reject) => {
        const onSeeked = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error('seek failed')); };
        const cleanup = () => {
          video.removeEventListener('seeked', onSeeked);
          video.removeEventListener('error', onError);
        };
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        // Son kare tam `duration`da boş gelebiliyor: bir tık geriden al.
        video.currentTime = Math.min(seconds, Math.max(0, duration - 0.05));
      });

    const run = async () => {
      try {
        if (video.readyState < 1) {
          await new Promise<void>((resolve, reject) => {
            video.addEventListener('loadedmetadata', () => resolve(), { once: true });
            video.addEventListener('error', () => reject(new Error('load failed')), { once: true });
          });
        }
        if (cancelled || !context) throw new Error('no canvas');

        const ratio = video.videoWidth > 0 && video.videoHeight > 0
          ? video.videoWidth / video.videoHeight
          : 16 / 9;
        canvas.height = FRAME_HEIGHT;
        canvas.width = Math.max(2, Math.round(FRAME_HEIGHT * ratio));

        for (let index = 0; index < count; index++) {
          if (cancelled) return;
          const seconds = secondsFor(index);
          await seekTo(seconds);
          if (cancelled) return;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frameUrl = canvas.toDataURL('image/jpeg', 0.6);
          setState((prev) => ({
            frames: [...prev.frames, { seconds, url: frameUrl }],
            done: index === count - 1,
            failed: false,
          }));
        }
      } catch {
        if (!cancelled) setState({ frames: [], done: true, failed: true });
      }
    };

    void run();

    return () => {
      cancelled = true;
      // Kaynağı bırak: yarıda kesilen indirme bağlantıyı açık tutmasın.
      video.removeAttribute('src');
      video.load();
    };
  }, [url, duration, count]);

  return state;
}
