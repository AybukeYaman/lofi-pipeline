/**
 * Timeline zaman cetveli — `00:00 ──── 01:00 ──── 02:00` şeridinin
 * hesabı. Saf fonksiyon: sürükleme/çizim yok, bu yüzden test edilebilir.
 */

/**
 * Cetvel adımları. Etiketli adım bu listeden seçilir: insan okuyacağı için
 * "17.3 sn" gibi hesaptan çıkan tuhaf sayılar yerine saat/dakika/saniyenin
 * alıştığımız bölümleri (1, 2, 5, 10, 15, 30 sn; 1, 2, 5, 10, 15, 30 dk; saat).
 */
const NICE_STEPS = [
  0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800,
];

export type TimelineTick = {
  /** Saniye cinsinden konum. */
  seconds: number;
  /** Timeline genişliğine göre yüzde — doğrudan `left` olarak kullanılır. */
  percent: number;
  /** Etiketli (uzun) çizgi mi, yoksa aradaki kısa çizgi mi? */
  major: boolean;
  /** Yalnızca `major` olanlarda dolu: `01:00` gibi. */
  label: string | null;
};

/** `01:20`, `1:02:30` — cetvel etiketi (saniye kesri gösterilmez). */
export function formatTickLabel(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const body = `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${body}` : body;
}

/**
 * Etiketler arası adımı seçer: `width / minLabelGap` kadar etiket sığıyor,
 * o yüzden bölüm başına düşen süreden BÜYÜK ilk "güzel" adım alınır. Video
 * uzadıkça adım kendiliğinden 1 sn → 10 sn → 1 dk → 5 dk diye açılır.
 *
 * @param duration video süresi (saniye)
 * @param width timeline'ın piksel genişliği
 * @param minLabelGap iki etiket arasında en az kaç piksel kalsın
 */
export function pickTickStep(duration: number, width: number, minLabelGap = 72) {
  if (!(duration > 0) || !(width > 0)) return null;
  const maxLabels = Math.max(2, Math.floor(width / minLabelGap));
  const rough = duration / maxLabels;
  return NICE_STEPS.find((step) => step >= rough) ?? NICE_STEPS[NICE_STEPS.length - 1];
}

/**
 * Cetvel çizgileri. Etiketli çizgiler `step` aralıklı; aralarına 4 eşit
 * parçaya bölen kısa çizgiler konur (CapCut'taki ince taksimat). Son çizgi
 * videonun sonunu da gösterir — kullanıcı "burası bitiş" diye görsün.
 */
export function buildTicks(duration: number, width: number, minLabelGap = 72): TimelineTick[] {
  const step = pickTickStep(duration, width, minLabelGap);
  if (step === null) return [];

  const minor = step / 4;
  const ticks: TimelineTick[] = [];
  // Kayan nokta birikmesin: konum hep indeksten hesaplanıyor.
  const count = Math.floor(duration / minor);
  for (let index = 0; index <= count; index++) {
    const seconds = Number((index * minor).toFixed(3));
    if (seconds > duration) break;
    // `index % 4` yerine adıma bölünebilirlik: minor kesirli olabiliyor.
    const major = index % 4 === 0;
    ticks.push({
      seconds,
      percent: (seconds / duration) * 100,
      major,
      label: major ? formatTickLabel(seconds) : null,
    });
  }

  // Videonun tam sonu bir taksimata denk gelmediyse etiketli çizgi olarak ekle.
  const last = ticks[ticks.length - 1];
  if (!last || duration - last.seconds > minor / 2) {
    ticks.push({
      seconds: duration,
      percent: 100,
      major: true,
      label: formatTickLabel(duration),
    });
  }
  return ticks;
}
