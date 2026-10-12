/**
 * Pomodoro görüntü planı — hangi oturumda hangi görüntü, kaç kare.
 *
 * Tek sorumluluk: WORK/BREAK oturumlarını KARE cinsinden parçalara bölmek.
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

/**
 * @typedef {object} SessionPart
 * @property {number} index oturum sırası
 * @property {'ready'|'work'|'break'} kind oturum türü
 * @property {'work'|'break'} visual hangi görüntü gösterilir (GET READY çalışma görüntüsünü kullanır)
 * @property {number} startFrame
 * @property {number} frames parçanın toplam kare sayısı
 * @property {number} clipFrames bu oturumun görüntüsünün tek tekrar kare sayısı
 * @property {number} copies tam tekrar sayısı (kopyalanır)
 * @property {number} tailFrames kalan kare (encode edilir), 0 olabilir
 * @property {number} fadeFrames kuyruğun SONUNDAKİ kararma (yalnız son oturum)
 */

/**
 * @param {object} input
 * @param {Array<{ kind: 'ready'|'work'|'break', startSeconds: number, endSeconds: number }>} input.sessions
 * @param {number} input.fps
 * @param {{ work: number, break: number }} input.clipFrames görüntü başına tek tekrar kare sayısı
 * @param {number} input.totalFrames videonun toplam kare sayısı (sesin süresinden)
 * @param {number} [input.fadeFrames] sondaki kararma, kare
 * @returns {{ fps: number, totalFrames: number, fadeFrames: number, parts: SessionPart[] }}
 */
export function planSessionFrames({ sessions, fps, clipFrames, totalFrames, fadeFrames = 0 }) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    throw new Error('Pomodoro görüntü planı için en az bir oturum gerekir.');
  }
  for (const kind of ['work', 'break']) {
    if (!(clipFrames[kind] > 0)) throw new Error(`Geçersiz ${kind} görüntüsü: ${clipFrames[kind]} kare.`);
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
      throw new Error(`${session.kind} oturumu ${index + 1} için kare kalmadı (süre çok kısa ya da ses timeline'dan kısa).`);
    }

    const visual = session.kind === 'break' ? 'break' : 'work';
    const clip = clipFrames[visual];
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
