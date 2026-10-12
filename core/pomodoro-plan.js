/**
 * Pomodoro seçimi → normalize edilmiş oturum planı, timeline ve cue olayları.
 *
 * Tek sorumluluk: `project.json`'daki `pomodoro` alanını TEK bir plana çevirmek,
 * o plandan WORK/BREAK oturumlarını ve ses işaretlerinin (countdown beep +
 * oturum başlangıç efekti) zamanlarını hesaplamak, seçilen müziğin bu
 * timeline'ı doldurup doldurmadığını söylemek.
 *
 * Dosya sistemine dokunmaz, ffmpeg çağırmaz, ses ölçmez — kırpma
 * `steps/02-audio-concat.js`'in, işaret seslerinin üretimi
 * `steps/06-pomodoro-cues.js`'in, yolların çözülmesi `core/config.js`'in işi.
 * `core/ambient-plan.js` ile aynı desen: şekil çözümleme karıştırmadan ayrı
 * durur, böylece yeni bir preset ya da yeni bir oturum türü tek dosyada eklenir.
 *
 * Kabul edilen şekil:
 *   "pomodoro": {
 *     "enabled": true,
 *     "preset": "50/10",        // workMinutes/breakMinutes'ı doldurur
 *     "workMinutes": 50,
 *     "breakMinutes": 10,
 *     "rounds": 4,
 *     "countdownSeconds": 3,
 *     "countdownBeep": true,
 *     "workStartSound": true,
 *     "breakStartSound": true,
 *     "trimExcess": false,      // fazla müzik kullanıcı onayıyla kırpılır
 *     "breakClip": null,        // mola görüntüsü (resim ya da döngü videosu); boşsa mola da çalışma görüntüsünü kullanır
 *     "cue": { "volumeDb": -10, "beepFile": null, "workStartFile": null, "breakStartFile": null }
 *   }
 */

/**
 * Hazır düzenler. `id` kullanıcıya gösterilen ad ve `preset` alanına yazılan değer.
 * Yeni preset eklemek: buraya bir kayıt — başka hiçbir yer bilmek zorunda değil.
 */
export const POMODORO_PRESETS = [
  { id: '50/10', workMinutes: 50, breakMinutes: 10 },
  { id: '30/10', workMinutes: 30, breakMinutes: 10 },
];

/** Oturum türleri. Timeline bu sırayla üretilir: her turda önce WORK, sonra BREAK. */
export const SESSION_KINDS = ['work', 'break'];

/** Varsayılanlar — UI ve config aynı değerleri buradan okur. */
export const POMODORO_DEFAULTS = {
  enabled: false,
  workMinutes: 50,
  breakMinutes: 10,
  rounds: 4,
  countdownSeconds: 3,
  countdownBeep: true,
  workStartSound: true,
  breakStartSound: true,
  /** Fazla müzik sorulmadan kırpılmaz; kullanıcı onayı bu bayrağı açar. */
  trimExcess: false,
  /**
   * Mola görüntüsü (resim ya da döngü videosu, proje klasörüne göreli yol).
   * null → mola da çalışma görüntüsünü (`clip`) kullanır. Çalışma görüntüsü
   * için ayrı alan yok: o `project.json` → `clip`.
   */
  breakClip: null,
  cue: {
    /** İşaret seslerinin müziğe göre seviyesi (LU). Müziği bastırmaz, duyulur. */
    volumeDb: -10,
    /** null → ffmpeg sine kaynağıyla üretilir; yol verilirse o dosya çalınır. */
    beepFile: null,
    workStartFile: null,
    breakStartFile: null,
  },
};

/** Sınırlar — uydurma değer yerine anlaşılır hata. */
const RANGES = {
  workMinutes: { min: 1, max: 180 },
  breakMinutes: { min: 1, max: 60 },
  rounds: { min: 1, max: 24 },
  countdownSeconds: { min: 0, max: 10 },
  volumeDb: { min: -60, max: 12 },
};

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
 * @typedef {object} PomodoroPlan
 * @property {number} workMinutes
 * @property {number} breakMinutes
 * @property {number} rounds
 * @property {string|null} preset Eşleşen hazır düzenin kimliği, yoksa null.
 * @property {number} countdownSeconds
 * @property {boolean} countdownBeep
 * @property {boolean} workStartSound
 * @property {boolean} breakStartSound
 * @property {boolean} trimExcess
 * @property {string|null} breakClip Mola görüntüsünün yolu, yoksa null (mola = çalışma görüntüsü).
 * @property {{ volumeDb: number, beepFile: string|null, workStartFile: string|null, breakStartFile: string|null }} cue
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

  const preset = readPreset(raw.preset, `${field}.preset`, problems);
  const workMinutes = readNumber(
    raw.workMinutes, `${field}.workMinutes`, RANGES.workMinutes,
    preset?.workMinutes ?? POMODORO_DEFAULTS.workMinutes, problems,
  );
  const breakMinutes = readNumber(
    raw.breakMinutes, `${field}.breakMinutes`, RANGES.breakMinutes,
    preset?.breakMinutes ?? POMODORO_DEFAULTS.breakMinutes, problems,
  );
  const rounds = readNumber(
    raw.rounds, `${field}.rounds`, RANGES.rounds, POMODORO_DEFAULTS.rounds, problems,
  );
  const countdownSeconds = readNumber(
    raw.countdownSeconds, `${field}.countdownSeconds`, RANGES.countdownSeconds,
    POMODORO_DEFAULTS.countdownSeconds, problems,
  );

  const plan = {
    workMinutes,
    breakMinutes,
    rounds,
    // Değerler bir hazır düzene denk geliyorsa kimliği taşınır: UI "50/10"
    // düğmesini seçili gösterebilsin, kullanıcı elle yazsa bile.
    preset: presetIdFor(workMinutes, breakMinutes),
    countdownSeconds,
    countdownBeep: readBoolean(raw.countdownBeep, `${field}.countdownBeep`, POMODORO_DEFAULTS.countdownBeep, problems),
    workStartSound: readBoolean(raw.workStartSound, `${field}.workStartSound`, POMODORO_DEFAULTS.workStartSound, problems),
    breakStartSound: readBoolean(raw.breakStartSound, `${field}.breakStartSound`, POMODORO_DEFAULTS.breakStartSound, problems),
    trimExcess: readBoolean(raw.trimExcess, `${field}.trimExcess`, POMODORO_DEFAULTS.trimExcess, problems),
    breakClip: readBreakClip(raw.breakClip, `${field}.breakClip`, problems),
    cue: readCue(raw.cue, `${field}.cue`, problems),
  };

  return { plan, problems };
}

/**
 * Plandan WORK/BREAK oturumlarını üretir.
 *
 * Her tur bir WORK ve ardından bir BREAK'tir (spec örneği: 50/10 × 4 →
 * WORK 01 … BREAK 04, toplam 240 dk). Tur sayısı değişince timeline kendiliğinden
 * yeniden kurulur; başka hiçbir yerde süre hesabı yok.
 *
 * @param {PomodoroPlan} plan
 * @returns {{
 *   sessions: Array<{ index: number, kind: 'work'|'break', round: number, label: string,
 *     startSeconds: number, endSeconds: number, durationSeconds: number }>,
 *   totalSeconds: number,
 *   totalMinutes: number,
 * }}
 */
export function buildTimeline(plan) {
  const sessions = [];
  let elapsed = 0;
  let index = 0;

  for (let round = 1; round <= plan.rounds; round++) {
    for (const kind of SESSION_KINDS) {
      const durationSeconds = (kind === 'work' ? plan.workMinutes : plan.breakMinutes) * 60;
      sessions.push({
        index: index++,
        kind,
        round,
        label: `${kind === 'work' ? 'WORK' : 'BREAK'} ${String(round).padStart(2, '0')}`,
        startSeconds: elapsed,
        endSeconds: elapsed + durationSeconds,
        durationSeconds,
      });
      elapsed += durationSeconds;
    }
  }

  return { sessions, totalSeconds: elapsed, totalMinutes: elapsed / 60 };
}

/**
 * Timeline'a yerleşecek ses işaretleri.
 *
 * Her oturum için: `countdownSeconds` saniye önce birer saniye arayla beep'ler
 * (T-3, T-2, T-1), tam başlangıç anında (T=0) oturum efekti. Böylece hem
 * WORK → BREAK hem BREAK → WORK geçişinde aynı geri sayım duyulur.
 *
 * İlk oturum t=0'da başlıyor: geri sayımı videodan ÖNCEYE düşerdi, o yüzden
 * atlanır ve `skipped` ile raporlanır — sessizce kaybolmasın. Başlangıç efekti
 * yerinde kalır (0. saniyede duyulur).
 *
 * @param {PomodoroPlan} plan
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @returns {{
 *   events: Array<{ atSeconds: number, type: 'beep'|'start', kind: 'work'|'break',
 *     session: number, label: string }>,
 *   skipped: Array<{ atSeconds: number, type: string, session: number, reason: string }>,
 * }}
 */
export function buildCueEvents(plan, timeline) {
  const events = [];
  const skipped = [];

  for (const session of timeline.sessions) {
    if (plan.countdownBeep && plan.countdownSeconds > 0) {
      for (let n = plan.countdownSeconds; n >= 1; n--) {
        const event = {
          atSeconds: session.startSeconds - n,
          type: 'beep',
          kind: session.kind,
          session: session.index,
          label: `${session.label} T-${n}`,
        };
        if (event.atSeconds < 0) {
          skipped.push({ ...event, reason: 'video başlamadan önceye düşüyor' });
        } else {
          events.push(event);
        }
      }
    }

    const soundOn = session.kind === 'work' ? plan.workStartSound : plan.breakStartSound;
    if (soundOn) {
      events.push({
        atSeconds: session.startSeconds,
        type: 'start',
        kind: session.kind,
        session: session.index,
        label: `${session.label} START`,
      });
    }
  }

  events.sort((a, b) => a.atSeconds - b.atSeconds);
  return { events, skipped };
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
    `(${plan.workMinutes}/${plan.breakMinutes} × ${plan.rounds} tur)\n` +
    `Müzik toplamı: ${formatClock(comparison.musicSeconds)}`;

  if (comparison.status === 'excess') {
    return (
      `${head}\nFazla: ${formatClock(comparison.excessSeconds)}\n\n` +
      'Müziklerin toplam süresi Pomodoro süresini aşıyor.\n' +
      'Montaja devam etmeden önce fazla kısmı kırpmanız gerekiyor.'
    );
  }
  if (comparison.status === 'short') {
    return (
      `${head}\nEksik: ${formatClock(comparison.shortSeconds)}\n\n` +
      "Seçilen müzikler Pomodoro timeline'ını doldurmuyor.\n" +
      'Montaja başlamadan önce parça ekleyin.'
    );
  }
  return `${head}\nMüzik timeline ile eşleşiyor.`;
}

/**
 * Timeline'ın okunur dökümü — rapora ve `pomodoro-timeline.txt` çıktısına yazılır.
 *
 *   WORK 01
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
 * bütün oturumlar doldurulabiliyor mu, cue olayları timeline'a sığıyor mu.
 *
 * `ok: false` ise montaj BAŞLATILMAZ. Fazla müzik kullanıcı onayıyla
 * (`plan.trimExcess`) kırpılabilir; eksik müzik üretilemez, her durumda durur.
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
 *   needsTrimConfirmation: boolean,
 *   problems: string[], warnings: string[], message: string|null,
 * }}
 */
export function validatePomodoro({ plan, tracks, tolerance = MATCH_TOLERANCE_SECONDS }) {
  const off = {
    enabled: false, ok: true, plan: null, timeline: null, comparison: null,
    trim: null, cues: null, needsTrimConfirmation: false,
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

  if (comparison.status === 'short') {
    problems.push(
      `Seçilen müzikler Pomodoro timeline'ını doldurmuyor: ${formatClock(comparison.shortSeconds)} eksik.`,
    );
  }

  const needsTrimConfirmation = comparison.status === 'excess' && !plan.trimExcess;
  if (needsTrimConfirmation) {
    problems.push(
      `Müzik toplamı Pomodoro süresini ${formatClock(comparison.excessSeconds)} aşıyor — ` +
      'kırpmayı onaylamadan montaj başlatılmaz.',
    );
  } else if (comparison.status === 'excess') {
    warnings.push(
      `Fazla ${formatClock(comparison.excessSeconds)} kırpılacak: ` +
      `${trim.trimmedCount} parça kısaltılıyor, ${trim.droppedCount} parça kullanılmıyor. ` +
      'Orijinal dosyalara dokunulmuyor.',
    );
  }

  // Bütün oturumlar doluyor mu: kırpmadan sonra kullanılan süre timeline'ı karşılamalı.
  const usedSeconds = trim ? trim.usedSeconds : comparison.musicSeconds;
  if (problems.length === 0 && usedSeconds + tolerance < timeline.totalSeconds) {
    problems.push(
      `Oturumlar doldurulamıyor: ${formatClock(usedSeconds)} ses var, ` +
      `${formatClock(timeline.totalSeconds)} gerekiyor.`,
    );
  }

  for (const skippedCue of cues.skipped) {
    warnings.push(`${skippedCue.label} atlandı: ${skippedCue.reason}.`);
  }
  // Cue'lar müziğin üstüne bindiriliyor; timeline'ın dışına taşan bir olay sessiz kalırdı.
  const strayCue = cues.events.find((event) => event.atSeconds > timeline.totalSeconds);
  if (strayCue) {
    problems.push(`${strayCue.label} timeline dışına düşüyor (${formatClock(strayCue.atSeconds)}).`);
  }

  return {
    enabled: true,
    ok: problems.length === 0,
    plan, timeline, comparison, trim, cues,
    needsTrimConfirmation,
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
 * Plandan `project.json`'a yazılacak sade şekil — varsayılandan sapmayan alan
 * yazılmaz, eski projelerin dosyası şişmez (`serializeAmbientPlan` ile aynı kural).
 *
 * @param {PomodoroPlan|null} plan null → anahtar silinir
 * @returns {object|undefined}
 */
export function serializePomodoroPlan(plan) {
  if (plan === null) return undefined;

  const out = {
    enabled: true,
    ...(plan.preset === null ? {} : { preset: plan.preset }),
    workMinutes: plan.workMinutes,
    breakMinutes: plan.breakMinutes,
    rounds: plan.rounds,
  };

  const defaults = POMODORO_DEFAULTS;
  for (const key of ['countdownSeconds', 'countdownBeep', 'workStartSound', 'breakStartSound', 'trimExcess', 'breakClip']) {
    if (plan[key] !== defaults[key]) out[key] = plan[key];
  }

  const cue = {};
  for (const key of ['volumeDb', 'beepFile', 'workStartFile', 'breakStartFile']) {
    if (plan.cue[key] !== defaults.cue[key]) cue[key] = plan.cue[key];
  }
  if (Object.keys(cue).length > 0) out.cue = cue;

  return out;
}

// ---------------------------------------------------------------- yardımcılar

/** Değerlere denk gelen hazır düzenin kimliği, yoksa null. */
export function presetIdFor(workMinutes, breakMinutes) {
  return POMODORO_PRESETS.find(
    (p) => p.workMinutes === workMinutes && p.breakMinutes === breakMinutes,
  )?.id ?? null;
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

function readBreakClip(value, key, problems) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: boş olmayan bir dosya yolu olmalı (mola da aynı görüntüyü kullansın diye alanı hiç yazma)`);
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
    workStartFile: file(raw.workStartFile, `${field}.workStartFile`),
    breakStartFile: file(raw.breakStartFile, `${field}.breakStartFile`),
  };
}
