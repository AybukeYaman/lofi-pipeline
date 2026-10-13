/**
 * Pomodoro görüntü planı — hangi oturumda hangi görüntü, kaç kare.
 *
 * Tek sorumluluk: oturumları (GET READY + durumlar) KARE cinsinden parçalara bölmek.
 * Dosya okumaz, ffmpeg çağırmaz; kopyalama/encode `steps/04-assemble.js`'in işi,
 * oturum zamanları `core/pomodoro-plan.js` `buildTimeline`'ın.
 *
 * Her oturum kendi görüntüsünün tam tekrarlarından (`copies`, kopyayla
 * birleştirilir) ve görüntünün başından kesilen bir kuyruktan (`tailFrames`,
 * encode edilir) oluşur. Böylece oturum sınırı döngü uzunluğuna denk gelmese de
 * kare sayısı tam tutar ve oturum her zaman görüntünün 0. karesinden başlar.
 *
 * Sınırlar saniyeden değil ARDIŞIK toplamdan yuvarlanır: her oturumu ayrı
 * yuvarlamak 48 oturumda birkaç karelik kayma biriktirirdi.
 */

/** Görüntüsü verilmemiş oturumların anahtarı: projenin ana görüntüsü (`clip`). */
export const MAIN_VISUAL_KEY = 'main';

/**
 * Oturumun görüntü anahtarı: kendi görüntüsü varsa onun yolu, yoksa ana görüntü.
 * Plan, `build.js` ve montaj aynı anahtarı kullanır — tek yerde.
 *
 * @param {{ visual?: string|null }} session
 */
export function visualKeyOf(session) {
  return session.visual ?? MAIN_VISUAL_KEY;
}

/**
 * Montajda hazırlanması gereken FARKLI görüntüler (durumlar + GET READY; ana
 * görüntüden ayrı olanlar). Aynı dosya iki yerde geçse tek kez döner; ana klibin
 * kendisi (`mainClip`) listeye girmez — onun base'i zaten hazır, `build.js` ona bağlar.
 * Girdi `core/config.js`in çözdüğü plan: `visual` mutlak yol, `visualSource` 'image' | 'clip'.
 *
 * @param {{ statuses: Array<{ visual: string|null, visualSource: string|null }>,
 *   intro: { visual: string|null, visualSource: string|null } }|null} pomodoro
 * @param {string|null} [mainClip] ana klibin mutlak yolu
 * @returns {Array<{ path: string, source: 'image'|'clip' }>}
 */
export function distinctVisuals(pomodoro, mainClip = null) {
  if (!pomodoro) return [];
  const found = new Map();
  for (const item of [pomodoro.intro, ...pomodoro.statuses]) {
    if (item.visual !== null && item.visual !== mainClip && !found.has(item.visual)) {
      found.set(item.visual, { path: item.visual, source: item.visualSource });
    }
  }
  return [...found.values()];
}

/**
 * @typedef {object} SessionPart
 * @property {number} index oturum sırası
 * @property {'ready'|'status'} kind oturum türü
 * @property {string} visual hangi görüntü gösterilir: oturumun görüntü anahtarı (`visualKey`)
 * @property {number} startFrame
 * @property {number} frames parçanın toplam kare sayısı
 * @property {number} clipFrames bu oturumun görüntüsünün tek tekrar kare sayısı
 * @property {number} copies tam tekrar sayısı (kopyalanır)
 * @property {number} tailFrames kalan kare (encode edilir), 0 olabilir
 * @property {number} fadeFrames kuyruğun SONUNDAKİ kararma (yalnız son oturum)
 */

/**
 * @param {object} input
 * @param {Array<{ kind: 'ready'|'status', visual?: string|null, startSeconds: number, endSeconds: number }>} input.sessions
 * @param {number} input.fps
 * @param {Record<string, number>} input.clipFrames görüntü anahtarı → tek tekrar kare sayısı
 * @param {number} input.totalFrames videonun toplam kare sayısı (sesin süresinden)
 * @param {number} [input.fadeFrames] sondaki kararma, kare
 * @returns {{ fps: number, totalFrames: number, fadeFrames: number, parts: SessionPart[] }}
 */
export function planSessionFrames({ sessions, fps, clipFrames, totalFrames, fadeFrames = 0 }) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('Pomodoro görüntü planı için en az bir oturum gerekir.');
  }
  for (const [key, frames] of Object.entries(clipFrames)) {
    if (!(frames > 0)) throw new Error(`Geçersiz görüntü (${key}): ${frames} kare.`);
  }
  if (!(totalFrames > 0)) throw new Error(`Geçersiz toplam süre: ${totalFrames} kare.`);

  const last = sessions.length - 1;
  const parts = [];

  sessions.forEach((session, index) => {
    const startFrame = index === 0 ? 0 : parts[index - 1].startFrame + parts[index - 1].frames;
    // Son oturum sesin sonuna kadar uzar: müzik timeline'dan toleransla uzunsa görüntü bitmesin.
    const endFrame = index === last
      ? totalFrames
      : Math.min(totalFrames, Math.round(session.endSeconds * fps));
    const frames = endFrame - startFrame;
    if (frames <= 0) {
      throw new Error(`${index + 1}. oturum için kare kalmadı (süre çok kısa ya da ses timeline'dan kısa).`);
    }

    const visual = visualKeyOf(session);
    const clip = clipFrames[visual];
    if (!(clip > 0)) throw new Error(`${index + 1}. oturumun görüntüsü hazırlanmamış: ${visual}`);
    const fade = index === last ? Math.min(fadeFrames, frames) : 0;
    const copies = Math.floor((frames - fade) / clip);

    parts.push({
      index,
      kind: session.kind,
      visual,
      startFrame,
      frames,
      clipFrames: clip,
      copies,
      tailFrames: frames - copies * clip,
      fadeFrames: fade,
    });
  });

  return { fps, totalFrames, fadeFrames: parts[last].fadeFrames, parts };
}

/**
 * Montaj sonrası kontrol edilecek birleşme noktaları (saniye): her oturum
 * geçişi, her gövde→kuyruk dikişi ve ilk klip→klip dikişi.
 *
 * @param {ReturnType<typeof planSessionFrames>} plan
 */
export function sessionJunctionPoints(plan) {
  const points = [];
  const round = (frames) => Number((frames / plan.fps).toFixed(3));
  let loopChecked = false;

  for (const part of plan.parts) {
    if (!loopChecked && part.copies >= 2) {
      points.push({ kind: 'klip→klip', seconds: round(part.startFrame + part.clipFrames) });
      loopChecked = true;
    }
    if (part.copies >= 1 && part.tailFrames > 0) {
      points.push({ kind: 'gövde→kuyruk', seconds: round(part.startFrame + part.copies * part.clipFrames) });
    }
    if (part.index > 0) {
      points.push({ kind: 'oturum geçişi', seconds: round(part.startFrame) });
    }
  }
  return points;
}
