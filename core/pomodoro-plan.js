/**
 * Pomodoro seçimi → normalize edilmiş durum listesi, timeline ve cue olayları.
 *
 * Tek sorumluluk: `project.json`'daki `pomodoro` alanını TEK bir plana çevirmek,
 * o plandan oturumları (GET READY + her turda durum listesi) ve ses işaretlerinin
 * (3'lü bip) zamanlarını hesaplamak, seçilen müziğin bu timeline'ı doldurup
 * doldurmadığını söylemek.
 *
 * Dosya sistemine dokunmaz, ffmpeg çağırmaz, ses ölçmez — kırpma
 * `steps/02-audio-concat.js`'in, işaret seslerinin üretimi
 * `steps/06-pomodoro-cues.js`'in, yolların çözülmesi `core/config.js`'in işi.
 * `core/ambient-plan.js` ile aynı desen: şekil çözümleme karıştırmadan ayrı
 * durur, böylece yeni bir hazır düzen ya da yeni bir alan tek dosyada eklenir.
 *
 * Kabul edilen şekil (yazılan şekil budur):
 *   "pomodoro": {
 *     "enabled": true,
 *     "rounds": 4,
 *     "statuses": [                      // bir döngü: sırayla tekrarlanır
 *       { "name": "STUDY", "minutes": 50 },
 *       { "name": "BREAK", "minutes": 10, "visual": "./resimler/mola.png", "beep": true }
 *     ],
 *     "intro": { "visual": null },        // GET READY görüntüsü; boşsa ana görüntü (`clip`)
 *     "countdownSeconds": 3,
 *     "countdownBeep": true,              // her oturumun son 3 saniyesinde 3 bip
 *     "cue": { "volumeDb": -10, "beepFile": null }
 *   }
 *
 * Eski `project.json` şekli OKUNMAYA devam eder (hiçbir proje bozulmaz): `preset`,
 * `workMinutes`, `breakMinutes`, `breakClip` iki durumlu `[STUDY, BREAK]`
 * listesine çevrilir; `statuses` varsa o kazanır. Bu anahtarlar artık YAZILMAZ ve API
 * gövdesinde kabul edilmez (`legacyKeysIn`). Her durumun `visual`ı boşsa
 * projenin ana görüntüsü (`clip`) gösterilir; `beep: false` o durumun
 * bitişindeki bipi kapatır.
 *
 * Her Pomodoro videosu `INTRO_SECONDS` (2 dk) süren bir GET READY oturumuyla
 * başlar; `rounds` turluk döngü ondan sonra gelir. Bip akışının TAMAMI budur:
 * her oturumun (hazırlık dahil) bitişinden önce 3 bip. Ayrı başlangıç sesi yok.
 */

/**
 * Hazır düzenler (kayıtlı setlerin yerleşik hâli). `id` kullanıcıya gösterilen ad.
 * Yeni hazır düzen eklemek: buraya bir kayıt — başka hiçbir yer bilmek zorunda değil.
 */
export const POMODORO_PRESETS = [
  classicPreset('50/10', 50, 10),
  classicPreset('30/10', 30, 10),
];

function classicPreset(id, workMinutes, breakMinutes) {
  return {
    id,
    statuses: [
      { name: 'STUDY', minutes: workMinutes, beep: true, visual: null },
      { name: 'BREAK', minutes: breakMinutes, beep: true, visual: null },
    ],
  };
}

/** Videonun başındaki GET READY oturumu (sn): her Pomodoro videosunda var, ayarı yok. */
export const INTRO_SECONDS = 120;

/** GET READY oturumunun adı (ekranda yazan). Durum adları kullanıcıdan gelir. */
export const INTRO_NAME = 'GET READY';

/** Varsayılanlar — UI ve config aynı değerleri buradan okur. */
export const POMODORO_DEFAULTS = {
  enabled: false,
  rounds: 4,
  /** Varsayılan döngü: STUDY 50 + BREAK 10. */
  statuses: POMODORO_PRESETS[0].statuses,
  countdownSeconds: 3,
  countdownBeep: true,
  cue: {
    /** İşaret seslerinin müziğe göre seviyesi (LU). Müziği bastırmaz, duyulur. */
    volumeDb: -10,
    /** null → ffmpeg sine kaynağıyla üretilir; yol verilirse o dosya çalınır. */
    beepFile: null,
  },
};

/** Sınırlar — uydurma değer yerine anlaşılır hata. */
const RANGES = {
  minutes: { min: 1, max: 180 },
  rounds: { min: 1, max: 24 },
  countdownSeconds: { min: 0, max: 10 },
  volumeDb: { min: -60, max: 12 },
  statusCount: { min: 1, max: 8 },
};

/** Ekranda yazan durum adının en uzun hâli (karakter). */
export const STATUS_NAME_MAX = 24;

/**
 * Müzik ile timeline'ın "eşit" sayıldığı en büyük fark (sn).
 *
 * Parça süreleri çözülen örnek sayısından geliyor (core/probe.js); 4 saatlik bir
 * seçimde ondalıkların toplamı saniyenin altında bir sapma bırakıyor. Bir
 * saniyelik pay, "240:00 müzik / 240:00 pomodoro" durumunu yanlışlıkla eksik
 * saymayı engeller.
 */
export const MATCH_TOLERANCE_SECONDS = 1;

/**
 * @typedef {object} PomodoroStatus
 * @property {string} name ekranda yazan ad (STUDY, BREAK, STRETCH…)
 * @property {number} minutes süre, dakika
 * @property {string|null} visual görüntü yolu (resim ya da döngü videosu); null → ana görüntü (`clip`)
 * @property {boolean} beep bitişinde 3 bip çalsın mı
 */

/**
 * @typedef {object} PomodoroPlan
 * @property {PomodoroStatus[]} statuses bir döngü
 * @property {{ visual: string|null }} intro GET READY görüntüsü (null → ana görüntü)
 * @property {number} rounds
 * @property {string|null} preset döngü hazır bir düzene denk geliyorsa kimliği, yoksa null
 * @property {number} countdownSeconds
 * @property {boolean} countdownBeep
 * @property {{ volumeDb: number, beepFile: string|null }} cue
 */

/**
 * Ham `pomodoro` alanını plana çevirir.
 *
 * Hata atmaz: `core/config.js` bütün sorunları toplayıp tek seferde raporladığı
 * için sorunlar dizi olarak döner. Alan yoksa ya da `enabled: false` ise
 * `plan: null` döner — Pomodoro kapalı, sistem bugünkü gibi çalışır.
 *
 * @param {unknown} raw
 * @param {string} [field] hata mesajlarındaki alan adı
 * @returns {{ plan: PomodoroPlan|null, problems: string[] }}
 */
export function normalizePomodoroSelection(raw, field = 'pomodoro') {
  const problems = [];

  if (raw === undefined || raw === null) return { plan: null, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${field}: nesne olmalı`);
    return { plan: null, problems };
  }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    problems.push(`${field}.enabled: true ya da false olmalı (verilen: ${JSON.stringify(raw.enabled)})`);
  }
  // Kapalıysa geri kalan alanlar doğrulanmaz: kullanıcı ayarlarını saklayıp
  // modu kapatabilsin, kapalı bir blok build'i durdurmasın.
  if (raw.enabled !== true) return { plan: null, problems };

  const statuses = raw.statuses !== undefined && raw.statuses !== null
    ? readStatuses(raw.statuses, `${field}.statuses`, problems)
    : readLegacyStatuses(raw, field, problems);
  const rounds = readNumber(
    raw.rounds, `${field}.rounds`, RANGES.rounds, POMODORO_DEFAULTS.rounds, problems,
  );
  const countdownSeconds = readNumber(
    raw.countdownSeconds, `${field}.countdownSeconds`, RANGES.countdownSeconds,
    POMODORO_DEFAULTS.countdownSeconds, problems,
  );

  const plan = {
    statuses,
    intro: readIntro(raw.intro, `${field}.intro`, problems),
    rounds,
    // Döngü bir hazır düzene denk geliyorsa kimliği taşınır: UI "50/10"
    // düğmesini seçili gösterebilsin, kullanıcı elle yazsa bile.
    preset: presetIdFor(statuses),
    countdownSeconds,
    countdownBeep: readBoolean(raw.countdownBeep, `${field}.countdownBeep`, POMODORO_DEFAULTS.countdownBeep, problems),
    cue: readCue(raw.cue, `${field}.cue`, problems),
  };

  return { plan, problems };
}

/**
 * Plandan oturumları üretir: önce 2 dk GET READY, sonra her turda durum listesi sırayla.
 *
 * Spec örneği: 50/10 × 4 → GET READY, STUDY 01 … BREAK 04, toplam 242 dk.
 * Tur sayısı ya da liste değişince timeline kendiliğinden yeniden kurulur;
 * başka hiçbir yerde süre hesabı yok.
 *
 * Oturum: `kind` 'ready' | 'status'; `name` ekranda yazan ad; `statusIndex` döngüdeki
 * sırası (GET READY için -1); `visual` o oturumun görüntü yolu (null → ana görüntü);
 * `beep` bitişinde bip çalar mı.
 *
 * @param {PomodoroPlan} plan
 * @returns {{
 *   sessions: Array<{ index: number, kind: 'ready'|'status', statusIndex: number, name: string,
 *     round: number, label: string, visual: string|null, beep: boolean,
 *     startSeconds: number, endSeconds: number, durationSeconds: number }>,
 *   totalSeconds: number,
 *   totalMinutes: number,
 * }}
 */
export function buildTimeline(plan) {
  const sessions = [{
    index: 0,
    kind: 'ready',
    statusIndex: -1,
    name: INTRO_NAME,
    round: 0,
    label: INTRO_NAME,
    visual: plan.intro?.visual ?? null,
    beep: true,
    startSeconds: 0,
    endSeconds: INTRO_SECONDS,
    durationSeconds: INTRO_SECONDS,
  }];
  let elapsed = INTRO_SECONDS;

  for (let round = 1; round <= plan.rounds; round++) {
    plan.statuses.forEach((status, statusIndex) => {
      const durationSeconds = status.minutes * 60;
      sessions.push({
        index: sessions.length,
        kind: 'status',
        statusIndex,
        name: status.name,
        round,
        label: `${status.name} ${String(round).padStart(2, '0')}`,
        visual: status.visual,
        beep: status.beep,
        startSeconds: elapsed,
        endSeconds: elapsed + durationSeconds,
        durationSeconds,
      });
      elapsed += durationSeconds;
    });
  }

  return { sessions, totalSeconds: elapsed, totalMinutes: elapsed / 60 };
}

/**
 * Timeline'a yerleşecek bip olayları.
 *
 * Bip akışının TAMAMI: her oturumun (GET READY, her durum — videonun son oturumu
 * dahil) bitişinden `countdownSeconds` saniye önce birer saniye arayla bip'ler
 * (T-3, T-2, T-1). `beep: false` olan durumda bip yok. Başlangıç sesi yok.
 *
 * Her oturum en az 1 dk sürdüğü için hiçbir bip videonun başından önceye düşmez.
 *
 * @param {PomodoroPlan} plan
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @returns {{ events: Array<{ atSeconds: number, type: 'beep', kind: 'ready'|'status',
 *   session: number, label: string }> }}
 */
export function buildCueEvents(plan, timeline) {
  const events = [];

  if (plan.countdownBeep && plan.countdownSeconds > 0) {
    for (const session of timeline.sessions) {
      if (!session.beep) continue;
      for (let n = plan.countdownSeconds; n >= 1; n--) {
        events.push({
          atSeconds: session.endSeconds - n,
          type: 'beep',
          kind: session.kind,
          session: session.index,
          label: `${session.label} T-${n}`,
        });
      }
    }
  }

  events.sort((a, b) => a.atSeconds - b.atSeconds);
  return { events };
}

/**
 * Seçilen müzik ile timeline'ı karşılaştırır — montajdan ÖNCE sorulan soru.
 *
 * @param {object} input
 * @param {number} input.musicSeconds seçilen parçaların toplam süresi
 * @param {ReturnType<typeof buildTimeline>} input.timeline
 * @param {number} [input.tolerance]
 * @returns {{
 *   status: 'exact'|'excess'|'short', ok: boolean,
 *   musicSeconds: number, timelineSeconds: number,
 *   excessSeconds: number, shortSeconds: number,
 * }}
 */
export function compareMusic({ musicSeconds, timeline, tolerance = MATCH_TOLERANCE_SECONDS }) {
  const timelineSeconds = timeline.totalSeconds;
  const delta = musicSeconds - timelineSeconds;
  const status = Math.abs(delta) <= tolerance ? 'exact' : (delta > 0 ? 'excess' : 'short');

  return {
    status,
    // Fazla müzik kırpılabilir (kullanıcı onayıyla); eksik müzik üretilemez.
    ok: status === 'exact',
    musicSeconds: Number(musicSeconds.toFixed(3)),
    timelineSeconds,
    excessSeconds: status === 'excess' ? Number(delta.toFixed(3)) : 0,
    shortSeconds: status === 'short' ? Number((-delta).toFixed(3)) : 0,
  };
}

/**
 * Fazla müziği timeline'a sığdıran kırpma planı.
 *
 * Track sınırları korunur: sığan parçalar olduğu gibi kalır, sınıra denk gelen
 * SON parça yalnızca gereken kadarıyla kullanılır, ondan sonrakiler hiç
 * kullanılmaz. Orijinal dosyalara dokunulmaz — bu plan `steps/02-audio-concat.js`
 * concat filtresinde `atrim` olarak uygulanır.
 *
 * @param {Array<{ path: string, duration: number }>} tracks çalma sırasıyla
 * @param {number} totalSeconds timeline süresi
 * @returns {{
 *   tracks: Array<{ index: number, path: string, duration: number, usedDuration: number,
 *     startSeconds: number, trimmed: boolean, dropped: boolean }>,
 *   usedSeconds: number, trimmedSeconds: number, droppedCount: number, trimmedCount: number,
 * }}
 */
export function planTrim(tracks, totalSeconds) {
  const planned = [];
  let elapsed = 0;

  for (const [index, track] of tracks.entries()) {
    const remaining = totalSeconds - elapsed;
    // Yuvarlama artığı kadar yer kalmışsa parçayı hiç başlatma: 0.004 sn'lik bir
    // kuyruk parçası tracklist'te anlamsız bir damga üretirdi.
    const room = remaining > MATCH_TOLERANCE_SECONDS / 10 ? remaining : 0;
    const usedDuration = Math.min(track.duration, room);

    planned.push({
      index,
      path: track.path,
      duration: track.duration,
      usedDuration: Number(usedDuration.toFixed(3)),
      startSeconds: Number(elapsed.toFixed(3)),
      trimmed: usedDuration > 0 && usedDuration < track.duration,
      dropped: usedDuration === 0,
    });
    elapsed += usedDuration;
  }

  const used = planned.reduce((sum, t) => sum + t.usedDuration, 0);
  const total = tracks.reduce((sum, t) => sum + t.duration, 0);

  return {
    tracks: planned,
    usedSeconds: Number(used.toFixed(3)),
    trimmedSeconds: Number((total - used).toFixed(3)),
    droppedCount: planned.filter((t) => t.dropped).length,
    trimmedCount: planned.filter((t) => t.trimmed).length,
  };
}

/**
 * Saniyeyi `mm:ss` damgasına çevirir (`240:00`, `03:17`).
 *
 * Dakika saate çevrilmez: Pomodoro ekranında "240:00" okunabilir, "4:00:00" ise
 * tur süresiyle karışıyor. Tracklist damgaları bundan ayrı
 * (`steps/05-tracklist.js` `formatTimestamp`) — orası YouTube'un biçimi.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const total = Math.round(Math.abs(seconds));
  const sign = seconds < 0 ? '-' : '';
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, '0');
  return `${sign}${String(m).padStart(2, '0')}:${s}`;
}

/**
 * Karşılaştırmanın kullanıcıya gösterilecek metni — CLI hatası, API mesajı ve
 * web paneli aynı cümleleri kullansın diye tek yerde.
 *
 * @param {ReturnType<typeof compareMusic>} comparison
 * @param {PomodoroPlan} plan
 * @returns {string}
 */
export function describeComparison(comparison, plan) {
  const head =
    `Pomodoro timeline: ${formatClock(comparison.timelineSeconds)} ` +
    `(${describeCycle(plan.statuses)} × ${plan.rounds} tur + ${INTRO_SECONDS / 60} dk hazırlık)\n` +
    `Müzik toplamı: ${formatClock(comparison.musicSeconds)}`;

  if (comparison.status === 'excess') {
    return (
      `${head}\nFazla: ${formatClock(comparison.excessSeconds)}\n\n` +
      'Müziklerin toplam süresi Pomodoro süresini aşıyor.\n' +
      'Montaj sırasında fazla kısım otomatik kırpılır.'
    );
  }
  if (comparison.status === 'short') {
    return (
      `${head}\nEksik: ${formatClock(comparison.shortSeconds)}\n\n` +
      "Seçilen müzikler Pomodoro timeline'ını doldurmuyor.\n" +
      'Montaj yine de yapılır: müziğin bittiği yerden sonra yalnızca arka plan sesi (Ambiance) çalar.'
    );
  }
  return `${head}\nMüzik timeline ile eşleşiyor.`;
}

/**
 * Timeline'ın okunur dökümü — rapora ve `pomodoro-timeline.txt` çıktısına yazılır.
 *
 *   STUDY 01
 *   00:00 - 50:00
 *
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @returns {string}
 */
export function describeTimeline(timeline) {
  return timeline.sessions
    .map((s) => `${s.label}\n${formatClock(s.startSeconds)} - ${formatClock(s.endSeconds)}`)
    .join('\n\n') + '\n';
}

/**
 * Montaj öncesi doğrulama — Pomodoro'nun TEK karar noktası.
 *
 * `steps/02-audio-concat.js` (CLI/build, tek kare encode edilmeden önce) ve
 * `server/project-api.js` (kullanıcı Başlat'a basmadan önce) aynı sonucu
 * kullanır: iki yerde iki ayrı kural olup birbirinden sapmasın.
 *
 * Denetlenenler (spec bölüm 8): mod açık mı, preset ve tur sayısı geçerli mi,
 * toplam süre ne, müzik toplamı ne, fazla/eksik ne kadar, kaç kırpma gerekiyor,
 * eksik müzikte ses sessizlikle tamamlanacak mı.
 *
 * `ok: false` ise montaj BAŞLATILMAZ — yalnızca ölçülemeyen parça durdurur. Fazla
 * müzik soru sorulmadan, uyarıyla kırpılır (montajda son parça kısalır, kalanlar
 * kullanılmaz); eksik müzik de uyarıdır: ses sessizlikle timeline süresine
 * tamamlanır, kalanı arka plan sesi (Ambiance) doldurur.
 *
 * @param {object} input
 * @param {PomodoroPlan|null} input.plan null → Pomodoro kapalı
 * @param {Array<{ path: string, duration: number }>} input.tracks çalma sırasıyla
 * @param {number} [input.tolerance]
 * @returns {{
 *   enabled: boolean, ok: boolean, plan: PomodoroPlan|null,
 *   timeline: ReturnType<typeof buildTimeline>|null,
 *   comparison: ReturnType<typeof compareMusic>|null,
 *   trim: ReturnType<typeof planTrim>|null,
 *   cues: ReturnType<typeof buildCueEvents>|null,
 *   problems: string[], warnings: string[], message: string|null,
 * }}
 */
export function validatePomodoro({ plan, tracks, tolerance = MATCH_TOLERANCE_SECONDS }) {
  const off = {
    enabled: false, ok: true, plan: null, timeline: null, comparison: null,
    trim: null, cues: null,
    problems: [], warnings: [], message: null,
  };
  if (plan === null || plan === undefined) return off;

  const timeline = buildTimeline(plan);
  const musicSeconds = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  const comparison = compareMusic({ musicSeconds, timeline, tolerance });
  const cues = buildCueEvents(plan, timeline);
  const trim = comparison.status === 'excess' ? planTrim(tracks, timeline.totalSeconds) : null;

  const problems = [];
  const warnings = [];

  // Süresi ölçülemeyen parça: toplam yanlış çıkar, körlemesine montaj yapılmaz.
  const unmeasured = tracks.filter((track) => !Number.isFinite(track.duration));
  if (unmeasured.length > 0) {
    problems.push(`${unmeasured.length} parçanın süresi ölçülemedi — toplam süre güvenilir değil.`);
  }

  // Eksik müzik engel DEĞİL: kalan süreyi arka plan sesi (Ambiance) doldurur, yoksa sessiz kalır.
  // Montajda (02) ses timeline süresine sessizlikle tamamlanır, video yarım kalmaz.
  if (comparison.status === 'short') {
    warnings.push(
      `Müzik ${formatClock(comparison.shortSeconds)} kısa: müzik bittikten sonra kalan süre ` +
      'yalnızca arka plan sesiyle (Ambiance) devam eder, o da seçili değilse sessiz kalır.',
    );
  }

  // Fazla müzik engel değil, UYARI: montaj kendiliğinden kırpar. Hiç kullanılmayacak
  // parçalar montaj başarıyla bitince Geri Dönüşüm Kutusu'na taşınır (build.js).
  if (comparison.status === 'excess') {
    warnings.push(
      `Fazla ${formatClock(comparison.excessSeconds)} montajda otomatik kırpılacak: ` +
      `${trim.trimmedCount} parça kısaltılacak, ${trim.droppedCount} parça kullanılmayacak` +
      (trim.droppedCount > 0
        ? ' (montaj bitince Geri Dönüşüm Kutusu\'na taşınır).'
        : '.'),
    );
  }

  return {
    enabled: true,
    ok: problems.length === 0,
    plan, timeline, comparison, trim, cues,
    problems, warnings,
    message: describeComparison(comparison, plan),
  };
}

/** Doğrulama geçmeden montaj başlatıldığında atılır — build.js bunu kullanıcıya basar. */
export class PomodoroValidationError extends Error {
  /** @param {ReturnType<typeof validatePomodoro>} validation */
  constructor(validation) {
    super(`${validation.message}\n\n` + validation.problems.map((p) => `  - ${p}`).join('\n'));
    this.name = 'PomodoroValidationError';
    this.validation = validation;
  }
}

/**
 * Plandan `project.json`'a yazılacak sade şekil — yazılan şekil YALNIZCA `statuses`
 * (eski `workMinutes/breakMinutes/breakClip/preset` yazılmaz; dosyada varsa okunmaya devam eder).
 * Varsayılandan sapmayan alan yazılmaz, dosya şişmez (`serializeAmbientPlan` ile aynı kural).
 *
 * @param {PomodoroPlan|null} plan null → anahtar silinir
 * @returns {object|undefined}
 */
export function serializePomodoroPlan(plan) {
  if (plan === null) return undefined;

  const out = {
    enabled: true,
    rounds: plan.rounds,
    statuses: plan.statuses.map((status) => ({
      name: status.name,
      minutes: status.minutes,
      ...(status.visual === null ? {} : { visual: status.visual }),
      ...(status.beep ? {} : { beep: false }),
    })),
  };
  if (plan.intro.visual !== null) out.intro = { visual: plan.intro.visual };

  const defaults = POMODORO_DEFAULTS;
  for (const key of ['countdownSeconds', 'countdownBeep']) {
    if (plan[key] !== defaults[key]) out[key] = plan[key];
  }

  const cue = {};
  for (const key of ['volumeDb', 'beepFile']) {
    if (plan.cue[key] !== defaults.cue[key]) cue[key] = plan.cue[key];
  }
  if (Object.keys(cue).length > 0) out.cue = cue;

  return out;
}

// ---------------------------------------------------------------- yardımcılar

/**
 * Döngünün hazır bir düzene denk gelen kimliği, yoksa null. Yalnızca süreler
 * karşılaştırılır (ad ve görüntü değil): "50/10" düğmesi, ad ya da görüntü
 * değişse de aynı süreleri gösterir.
 *
 * @param {PomodoroStatus[]} statuses
 */
export function presetIdFor(statuses) {
  return POMODORO_PRESETS.find((preset) => (
    preset.statuses.length === statuses.length
    && preset.statuses.every((status, i) => status.minutes === statuses[i].minutes)
  ))?.id ?? null;
}

/** Döngünün kısa özeti: süreler `/` ile (`50/10`, `25/5/15`). Tek yerde: ekran ve hata metinleri. */
export function describeCycle(statuses) {
  return statuses.map((status) => status.minutes).join('/');
}

/** Eski `project.json` anahtarları: yalnızca OKUNUR; yeni yazımda ve API gövdesinde kullanılmaz. */
const LEGACY_KEYS = ['preset', 'workMinutes', 'breakMinutes', 'breakClip'];

/**
 * Bir gövdede eski anahtar var mı: API bunları reddeder (`statuses` kullanılmalı).
 *
 * @param {unknown} raw
 * @returns {string[]} bulunan eski anahtarlar
 */
export function legacyKeysIn(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return LEGACY_KEYS.filter((key) => raw[key] !== undefined);
}

/** Eski şekil (`preset`/`workMinutes`/`breakMinutes`/`breakClip`) → `[STUDY, BREAK]` listesi. */
function readLegacyStatuses(raw, field, problems) {
  const preset = readPreset(raw.preset, `${field}.preset`, problems);
  const [defaultWork, defaultBreak] = (preset ?? POMODORO_PRESETS[0]).statuses;
  const work = readNumber(
    raw.workMinutes, `${field}.workMinutes`, RANGES.minutes, defaultWork.minutes, problems,
  );
  const rest = readNumber(
    raw.breakMinutes, `${field}.breakMinutes`, { min: 1, max: 60 }, defaultBreak.minutes, problems,
  );
  return [
    { name: 'STUDY', minutes: work, visual: null, beep: true },
    {
      name: 'BREAK',
      minutes: rest,
      visual: readVisual(raw.breakClip, `${field}.breakClip`, problems),
      beep: true,
    },
  ];
}

/**
 * Durum listesini tek başına doğrular (kayıtlı setler de aynı kuralı kullanır).
 *
 * @param {unknown} value
 * @param {string} [key] hata mesajlarındaki alan adı
 * @returns {{ statuses: PomodoroStatus[], problems: string[] }}
 */
export function normalizeStatusList(value, key = 'statuses') {
  const problems = [];
  const statuses = readStatuses(value, key, problems);
  return { statuses, problems };
}

function readStatuses(value, key, problems) {
  const fallback = POMODORO_DEFAULTS.statuses.map((status) => ({ ...status }));
  const { min, max } = RANGES.statusCount;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    problems.push(`${key}: ${min} ile ${max} arasında durum içeren bir liste olmalı`);
    return fallback;
  }

  return value.map((item, i) => {
    const at = `${key}[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${at}: nesne olmalı ({ "name": "STUDY", "minutes": 50 })`);
      return { name: `DURUM ${i + 1}`, minutes: 10, visual: null, beep: true };
    }
    return {
      name: readStatusName(item.name, `${at}.name`, i, problems),
      minutes: readNumber(item.minutes, `${at}.minutes`, RANGES.minutes, 10, problems),
      visual: readVisual(item.visual, `${at}.visual`, problems),
      beep: readBoolean(item.beep, `${at}.beep`, true, problems),
    };
  });
}

function readStatusName(value, key, index, problems) {
  const fallback = `DURUM ${index + 1}`;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: ekranda yazacak bir ad gerekli (örn. "STUDY")`);
    return fallback;
  }
  const name = value.trim();
  if (name.length > STATUS_NAME_MAX) {
    problems.push(`${key}: en fazla ${STATUS_NAME_MAX} karakter olabilir (verilen: ${name.length})`);
    return fallback;
  }
  if (/[\r\n]/.test(name)) {
    problems.push(`${key}: tek satır olmalı`);
    return fallback;
  }
  return name;
}

function readIntro(raw, key, problems) {
  if (raw === undefined || raw === null) return { visual: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${key}: nesne olmalı ({ "visual": "./resimler/hazir.png" })`);
    return { visual: null };
  }
  return { visual: readVisual(raw.visual, `${key}.visual`, problems) };
}

function readPreset(value, key, problems) {
  if (value === undefined || value === null) return null;
  const found = POMODORO_PRESETS.find((p) => p.id === value);
  if (!found) {
    problems.push(
      `${key}: şunlardan biri olmalı: ${POMODORO_PRESETS.map((p) => `"${p.id}"`).join(', ')} ` +
      `(verilen: ${JSON.stringify(value)})`,
    );
    return null;
  }
  return found;
}

function readNumber(value, key, range, fallback, problems) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    problems.push(
      `${key}: ${range.min} ile ${range.max} arasında tam sayı olmalı (verilen: ${JSON.stringify(value)})`,
    );
    return fallback;
  }
  return value;
}

function readBoolean(value, key, fallback, problems) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    problems.push(`${key}: true ya da false olmalı (verilen: ${JSON.stringify(value)})`);
    return fallback;
  }
  return value;
}

/** Görüntü yolu: boş/yok → null (ana görüntü kullanılır). */
function readVisual(value, key, problems) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: boş olmayan bir dosya yolu olmalı (ana görüntü kullanılsın diye alanı hiç yazma)`);
    return null;
  }
  return value;
}

function readCue(raw, field, problems) {
  const defaults = POMODORO_DEFAULTS.cue;
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${field}: nesne olmalı`);
    return { ...defaults };
  }

  let volumeDb = defaults.volumeDb;
  if (raw.volumeDb !== undefined && raw.volumeDb !== null) {
    const ok = typeof raw.volumeDb === 'number' && Number.isFinite(raw.volumeDb)
      && raw.volumeDb >= RANGES.volumeDb.min && raw.volumeDb <= RANGES.volumeDb.max;
    if (ok) volumeDb = raw.volumeDb;
    else {
      problems.push(
        `${field}.volumeDb: ${RANGES.volumeDb.min} ile ${RANGES.volumeDb.max} arasında sayı olmalı ` +
        `(verilen: ${JSON.stringify(raw.volumeDb)})`,
      );
    }
  }

  const file = (value, key) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key}: boş olmayan bir dosya yolu olmalı (üretilen ses için alanı hiç yazma)`);
      return null;
    }
    return value;
  };

  return {
    volumeDb,
    beepFile: file(raw.beepFile, `${field}.beepFile`),
  };
}
