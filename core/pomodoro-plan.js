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
 * Model: ADIM → SET → LOOP.
 *   - Adım: bir çalışma ya da mola (ad, dakika, tür, bip, görüntü).
 *   - Set: art arda gelen adımlar + kaç kez art arda uygulanacağı (`repeat`).
 *   - Loop: setlerin TAMAMI sırayla uygulanır, sonra başa döner; `rounds` kez.
 *
 * Kabul edilen şekil:
 *   "pomodoro": {
 *     "enabled": true,
 *     "rounds": 2,                        // LOOP: tüm set sırası kaç kez
 *     "sets": [
 *       { "name": "SET 1", "repeat": 1, "steps": [
 *         { "name": "STUDY", "minutes": 50 },
 *         { "name": "BREAK", "minutes": 10 } ] },
 *       { "steps": [                        // ad yoksa "SET 2", tekrar yoksa 1
 *         { "name": "STUDY", "minutes": 50 },
 *         { "name": "LONG BREAK", "minutes": 20, "kind": "break", "beep": false,
 *           "visual": "./resimler/mola.png" } ] }
 *     ],
 *     "intro": { "visual": null },        // GET READY görüntüsü; boşsa ana görüntü (`clip`)
 *     "countdownSeconds": 3,
 *     "countdownBeep": true,              // her oturumun son 3 saniyesinde 3 bip
 *     "cue": { "volumeDb": -10, "beepFile": null }
 *   }
 *
 * Adım: `name` (≤24 karakter, tek satır), `minutes` (1–180), `kind` ('work' | 'break';
 * yoksa addan tahmin: `inferKind`), `beep` (varsayılan açık; false → o adımın
 * bitişinde bip yok), `visual` (boşsa ana görüntü). Set: `name` (varsayılan "SET n"),
 * `repeat` (1–10), `steps` (1–8 adım). En çok 6 set; bir turda (tekrarlar dahil) en çok 24 adım.
 *
 * Yazma (`serializePomodoroPlan`/`serializeSets`): tek, adı "SET 1" ve tekrarı 1 olan set
 * kısayol olarak `"statuses": [...]` yazılır (basit dosyalar basit kalır), aksi hâlde
 * `"sets": [...]`. `kind` yalnızca tahminden farklıysa yazılır.
 *
 * Okuma: `sets` varsa o; yoksa `statuses` TEK set olur; o da yoksa eski şekil
 * (`preset`, `workMinutes`, `breakMinutes`, `breakClip` → iki adımlı `[STUDY, BREAK]`,
 * `breakClip` BREAK görüntüsü). Eski anahtarlar artık YAZILMAZ ve API gövdesinde
 * kabul edilmez (`legacyKeysIn`).
 *
 * Her Pomodoro videosu `INTRO_SECONDS` (2 dk) süren bir GET READY oturumuyla
 * başlar; `rounds` turluk loop ondan sonra gelir. Bip akışının TAMAMI budur:
 * her oturumun (hazırlık dahil) bitişinden önce 3 bip. Ayrı başlangıç sesi yok.
 */

/**
 * Hazır programlar (kayıtlı programların yerleşik hâli). `id` kullanıcıya gösterilen ad.
 * Bir program bir ya da birkaç SET'ten oluşur; set = art arda gelen adımlar (+ kaç kez tekrar).
 * Yeni hazır program eklemek: buraya bir kayıt — başka hiçbir yer bilmek zorunda değil.
 * `statuses` her programın BİR TURUNUN açılmış (set tekrarları dahil) adım listesi.
 */
export const POMODORO_PRESETS = [
  makePreset('50/10', [['SET 1', 1, [['STUDY', 50], ['BREAK', 10]]]]),
  makePreset('30/10', [['SET 1', 1, [['STUDY', 30], ['BREAK', 10]]]]),
  makePreset('50/10/50/20', [
    ['SET 1', 1, [['STUDY', 50], ['BREAK', 10]]],
    ['SET 2', 1, [['STUDY', 50], ['LONG BREAK', 20]]],
  ]),
  makePreset('Klasik 25/5', [
    ['SET 1', 3, [['STUDY', 25], ['BREAK', 5]]],
    ['SET 2', 1, [['STUDY', 25], ['LONG BREAK', 15]]],
  ]),
];

function makePreset(id, definition) {
  const sets = definition.map(([name, repeat, steps]) => (
    makeSet(name, repeat, steps.map(([stepName, minutes]) => makeStep(stepName, minutes)))
  ));
  return { id, sets, statuses: flattenSets(sets) };
}

/** Videonun başındaki GET READY oturumu (sn): her Pomodoro videosunda var, ayarı yok. */
export const INTRO_SECONDS = 120;

/** GET READY oturumunun adı (ekranda yazan). Durum adları kullanıcıdan gelir. */
export const INTRO_NAME = 'GET READY';

/** Varsayılanlar — UI ve config aynı değerleri buradan okur. */
export const POMODORO_DEFAULTS = {
  enabled: false,
  rounds: 4,
  /** Varsayılan program: SET 1 = STUDY 50 + BREAK 10. */
  sets: POMODORO_PRESETS[0].sets,
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
  setCount: { min: 1, max: 6 },
  repeat: { min: 1, max: 10 },
  /** Bir turdaki toplam adım (set tekrarları dahil). */
  totalSteps: { min: 1, max: 24 },
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
 * @property {'work'|'break'} kind çalışma mı mola mı (adından tahmin edilir, değiştirilebilir)
 */

/**
 * @typedef {object} PomodoroSetDef
 * @property {string} name set adı (SET 1…)
 * @property {number} repeat set art arda kaç kez uygulanır
 * @property {PomodoroStatus[]} steps setin adımları, sırayla
 */

/**
 * @typedef {object} PomodoroPlan
 * @property {PomodoroSetDef[]} sets program: setler sırayla uygulanır; hepsi bitince LOOP başa döner (`rounds` kez)
 * @property {PomodoroStatus[]} statuses BİR TURUN açılmış (set tekrarları dahil) düz adım listesi — `sets`ten türer
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

  const sets = readSets(raw, field, problems);
  const statuses = flattenSets(sets);
  const rounds = readNumber(
    raw.rounds, `${field}.rounds`, RANGES.rounds, POMODORO_DEFAULTS.rounds, problems,
  );
  const countdownSeconds = readNumber(
    raw.countdownSeconds, `${field}.countdownSeconds`, RANGES.countdownSeconds,
    POMODORO_DEFAULTS.countdownSeconds, problems,
  );

  const plan = {
    sets,
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
 * Plandan oturumları üretir: önce 2 dk GET READY, sonra `rounds` kez: her set sırayla,
 * her set `repeat` kez, her setin adımları sırayla (LOOP = tüm set sırası).
 *
 * Örnek: 50/10/50/20 (SET 1: STUDY 50 + BREAK 10, SET 2: STUDY 50 + LONG BREAK 20) × 2 tur →
 * GET READY, STUDY 01, BREAK 01, STUDY 02, LONG BREAK 01, STUDY 03, BREAK 02, STUDY 04.
 * Video hiçbir zaman MOLAYLA BİTMEZ: son turun sonundaki molalar (burada LONG BREAK 02)
 * videoya girmez, `droppedTail`'de listelenir. Tur sayısı, set ya da adım değişince timeline
 * kendiliğinden yeniden kurulur; başka hiçbir yerde süre hesabı yok (arayüz önizlemesi de
 * bunu çağırır).
 *
 * Oturum: `kind` 'ready' | 'status'; `name` ekranda yazan ad; `label` adın kaçıncı kez
 * geçtiği (STUDY 03); `statusIndex` BİR TURUN açılmış adım listesindeki sırası (GET READY
 * için -1); `stepKind` 'work' | 'break'; `setIndex`/`setName`/`repeat` oturumun hangi set ve
 * hangi tekrarda olduğu; `visual` görüntü yolu (null → ana görüntü); `beep` bitişinde bip.
 *
 * @param {PomodoroPlan} plan
 * @returns {{
 *   sessions: Array<{ index: number, kind: 'ready'|'status', statusIndex: number, name: string,
 *     stepKind: 'ready'|'work'|'break', round: number, setIndex: number, setName: string|null,
 *     repeat: number, label: string, visual: string|null, beep: boolean,
 *     startSeconds: number, endSeconds: number, durationSeconds: number }>,
 *   totalSeconds: number,
 *   totalMinutes: number,
 *   droppedTail: Array<{ name: string, minutes: number }>,
 * }}
 */
export function buildTimeline(plan) {
  const sessions = [{
    index: 0,
    kind: 'ready',
    statusIndex: -1,
    name: INTRO_NAME,
    stepKind: 'ready',
    round: 0,
    setIndex: -1,
    setName: null,
    repeat: 0,
    label: INTRO_NAME,
    visual: plan.intro?.visual ?? null,
    beep: true,
    startSeconds: 0,
    endSeconds: INTRO_SECONDS,
    durationSeconds: INTRO_SECONDS,
  }];
  let elapsed = INTRO_SECONDS;
  const occurrences = new Map();

  for (let round = 1; round <= plan.rounds; round++) {
    let statusIndex = 0;
    plan.sets.forEach((set, setIndex) => {
      for (let repeat = 1; repeat <= set.repeat; repeat++) {
        for (const step of set.steps) {
          const durationSeconds = step.minutes * 60;
          const occurrence = (occurrences.get(step.name) ?? 0) + 1;
          occurrences.set(step.name, occurrence);
          sessions.push({
            index: sessions.length,
            kind: 'status',
            statusIndex: statusIndex++,
            name: step.name,
            stepKind: step.kind,
            round,
            setIndex,
            setName: set.name,
            repeat,
            label: `${step.name} ${String(occurrence).padStart(2, '0')}`,
            visual: step.visual,
            beep: step.beep,
            startSeconds: elapsed,
            endSeconds: elapsed + durationSeconds,
            durationSeconds,
          });
          elapsed += durationSeconds;
        }
      }
    });
  }

  // Video hiçbir zaman molayla bitmez: son turun sonundaki molalar videoya girmez
  // (programda hiç çalışma yoksa kural uygulanmaz).
  const droppedTail = [];
  if (sessions.some((session) => session.stepKind === 'work')) {
    while (sessions.at(-1).stepKind === 'break') {
      const dropped = sessions.pop();
      droppedTail.unshift({ name: dropped.name, minutes: dropped.durationSeconds / 60 });
      elapsed -= dropped.durationSeconds;
    }
  }

  return { sessions, totalSeconds: elapsed, totalMinutes: elapsed / 60, droppedTail };
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
 * Kısa müziği timeline'a tamamlayan çalma planı: liste bir kez olduğu gibi çalar, bitince
 * BAŞTAN tekrar başlar (gerekirse birkaç kez); videonun bittiği yerdeki parça kesilir.
 * Orijinal dosyalara dokunulmaz — `steps/02-audio-concat.js` aynı dosyayı concat'e yeniden
 * girdi olarak verir, kesilen parça `atrim` ile.
 *
 * @param {Array<{ path: string, duration: number }>} tracks çalma sırasıyla, hepsi ölçülmüş
 * @param {number} totalSeconds timeline süresi
 * @returns {{
 *   tracks: Array<{ index: number, path: string, duration: number, usedDuration: number,
 *     startSeconds: number, trimmed: boolean, repeat: boolean }>,
 *   repeatedSeconds: number, repeatedCount: number,
 * }}
 */
export function planFill(tracks, totalSeconds) {
  const planned = [];
  let elapsed = 0;
  const playable = tracks.filter((track) => track.duration > 0);
  // Yuvarlama artığı kadar yer kalmışsa yeni parça başlatılmaz (planTrim ile aynı pay).
  const room = () => totalSeconds - elapsed > MATCH_TOLERANCE_SECONDS / 10;

  for (let pass = 0; playable.length > 0 && room(); pass++) {
    for (const track of playable) {
      if (!room()) break;
      const usedDuration = Math.min(track.duration, totalSeconds - elapsed);
      planned.push({
        index: tracks.indexOf(track),
        path: track.path,
        duration: track.duration,
        usedDuration: Number(usedDuration.toFixed(3)),
        startSeconds: Number(elapsed.toFixed(3)),
        trimmed: usedDuration < track.duration,
        repeat: pass > 0,
      });
      elapsed += usedDuration;
    }
  }

  const repeated = planned.filter((track) => track.repeat);
  return {
    tracks: planned,
    repeatedSeconds: Number(repeated.reduce((sum, track) => sum + track.usedDuration, 0).toFixed(3)),
    repeatedCount: repeated.length,
  };
}

/**
 * Tekrar çalan parçaların kısa anlatımı (uyarı metni), ör.
 * "Amber Curtains, Rainy Window (toplam 12:30 tekrar; sonuncusu 03:20 çalıp kesilir)".
 * Aynı parça birden fazla kez tekrar ediyorsa adı bir kez, yanında "×3".
 */
function describeRepeats(fill) {
  const repeated = fill.tracks.filter((track) => track.repeat);
  const counts = new Map();
  for (const track of repeated) {
    const name = String(track.path).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.length > 6 ? `${names.slice(0, 6).join(', ')} ve ${names.length - 6} parça daha` : names.join(', ');
  const last = repeated.at(-1);
  const cut = last?.trimmed ? `; sonuncusu ${formatClock(last.usedDuration)} çalıp kesilir` : '';
  return `${shown} (toplam ${formatClock(fill.repeatedSeconds)} tekrar${cut})`;
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
    `(${describeCycle(plan.statuses)} × ${plan.rounds} tur + ${INTRO_SECONDS / 60} dk hazırlık` +
    `${describeDroppedTail(buildTimeline(plan).droppedTail)})\n` +
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
      'Montaj yine de yapılır: liste bitince baştaki parçalar tekrar çalar.'
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
 *   fill: ReturnType<typeof planFill>|null,
 *   cues: ReturnType<typeof buildCueEvents>|null,
 *   problems: string[], warnings: string[], message: string|null,
 * }}
 */
export function validatePomodoro({ plan, tracks, tolerance = MATCH_TOLERANCE_SECONDS }) {
  const off = {
    enabled: false, ok: true, plan: null, timeline: null, comparison: null,
    trim: null, fill: null, cues: null,
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

  // Eksik müzik engel DEĞİL: liste bitince baştaki parçalar tekrar çalar (montajda 02 bu planı
  // birleştirir). Hiç parça yoksa tekrar edecek bir şey yok: ses sessizlikle tamamlanır.
  const measured = unmeasured.length === 0 && tracks.length > 0;
  const fill = comparison.status === 'short' && measured ? planFill(tracks, timeline.totalSeconds) : null;
  if (comparison.status === 'short') {
    warnings.push(fill
      ? `Müzik ${formatClock(comparison.shortSeconds)} kısa: video dolsun diye baştaki parçalar ` +
        `tekrar çalacak: ${describeRepeats(fill)}.`
      : `Müzik ${formatClock(comparison.shortSeconds)} kısa ve tekrar edilecek parça yok: kalan süre ` +
        'yalnızca arka plan sesiyle (Ambiance) devam eder, o da seçili değilse sessiz kalır.');
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
    plan, timeline, comparison, trim, fill, cues,
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
 * Plandan `project.json`'a yazılacak sade şekil. Tek, adı varsayılan ("SET 1") ve tekrarı 1
 * olan set `statuses` olarak yazılır (basit dosyalar basit kalır); aksi hâlde `sets`.
 * Eski `workMinutes/breakMinutes/breakClip/preset` yazılmaz; dosyada varsa okunmaya devam eder.
 * Varsayılandan sapmayan alan yazılmaz, dosya şişmez (`serializeAmbientPlan` ile aynı kural).
 *
 * @param {PomodoroPlan|null} plan null → anahtar silinir
 * @returns {object|undefined}
 */
export function serializePomodoroPlan(plan) {
  if (plan === null) return undefined;

  const out = { enabled: true, rounds: plan.rounds, ...serializeSets(plan.sets) };
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

/**
 * Set listesinin dosya şekli: tek, adı varsayılan ("SET 1") ve tekrarı 1 olan set
 * `{ statuses }`, aksi hâlde `{ sets }`. Kayıtlı programlar da aynı şekli yazar.
 *
 * @param {PomodoroSetDef[]} sets
 */
export function serializeSets(sets) {
  const [only] = sets;
  if (sets.length === 1 && only.repeat === 1 && only.name === defaultSetName(0)) {
    return { statuses: only.steps.map(serializeStep) };
  }
  return {
    sets: sets.map((set, i) => ({
      ...(set.name === defaultSetName(i) ? {} : { name: set.name }),
      ...(set.repeat === 1 ? {} : { repeat: set.repeat }),
      steps: set.steps.map(serializeStep),
    })),
  };
}

/** Adımın dosyaya yazılan şekli: ad ve süre hep; görüntü, sessizlik ve (tahminden farklıysa) tür yalnızca gerektiğinde. */
function serializeStep(step) {
  return {
    name: step.name,
    minutes: step.minutes,
    ...(step.kind === inferKind(step.name) ? {} : { kind: step.kind }),
    ...(step.visual === null ? {} : { visual: step.visual }),
    ...(step.beep ? {} : { beep: false }),
  };
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

/**
 * Videoya girmeyen sondaki molaların notu — sunucu metinleri ve arayüz aynı cümleyi kullanır:
 * " − sondaki BREAK 10 dk" (düşen yoksa boş).
 *
 * @param {Array<{ name: string, minutes: number }>} droppedTail
 */
export function describeDroppedTail(droppedTail) {
  if (droppedTail.length === 0) return '';
  return ` − sondaki ${droppedTail.map((step) => `${step.name} ${step.minutes} dk`).join(' + ')}`;
}

/** Döngünün kısa özeti: süreler `/` ile (`50/10`, `25/5/15`). Tek yerde: ekran ve hata metinleri. */
export function describeCycle(statuses) {
  return statuses.map((status) => status.minutes).join('/');
}

/** Adım türleri: çalışma ya da mola. Önizleme, toplamlar ve renkler buna bakar. */
export const STEP_KINDS = ['work', 'break'];

/**
 * Adın türünü tahmin eder (kullanıcı satırdan değiştirebilir): mola/dinlenme anlamı
 * taşıyan adlar `break`, geri kalanı `work`.
 *
 * @param {string} name
 * @returns {'work'|'break'}
 */
export function inferKind(name) {
  return /break|mola|rest|stretch|esne|walk|y[uü]r[uü]|snack|nefes|(^|\s)ara(\s|$)/i.test(String(name)) ? 'break' : 'work';
}

/** Varsayılan set adı: SET 1, SET 2… */
export function defaultSetName(index) {
  return `SET ${index + 1}`;
}

/** Adım nesnesi (görüntü yok, bip açık, tür adından tahmin) — `extra` ile ezilir. */
export function makeStep(name, minutes, extra = {}) {
  return { name, minutes, visual: null, beep: true, kind: inferKind(name), ...extra };
}

/** Set nesnesi: ad, tekrar sayısı ve adımlar. */
export function makeSet(name, repeat, steps) {
  return { name, repeat, steps };
}

/**
 * Setleri BİR TURUN düz adım listesine açar: her set sırayla, her set `repeat` kez, adımlar
 * kopyalanır. Timeline, görüntü hazırlığı, etiketler ve özetler aynı listeyi kullanır.
 *
 * @param {Array<{ repeat: number, steps: PomodoroStatus[] }>} sets
 * @returns {PomodoroStatus[]}
 */
export function flattenSets(sets) {
  const flat = [];
  for (const set of sets) {
    for (let repeat = 0; repeat < set.repeat; repeat++) {
      for (const step of set.steps) flat.push({ ...step });
    }
  }
  return flat;
}

/**
 * Set listesini tek başına doğrular (kayıtlı programlar da aynı kuralı kullanır).
 *
 * @param {unknown} value
 * @param {string} [key] hata mesajlarındaki alan adı
 * @returns {{ sets: PomodoroSetDef[], problems: string[] }}
 */
export function normalizeSetList(value, key = 'sets') {
  const problems = [];
  const sets = readSetList(value, key, problems);
  return { sets, problems };
}

function readSetList(value, key, problems) {
  const fallback = () => POMODORO_DEFAULTS.sets.map((set) => ({ ...set, steps: set.steps.map((s) => ({ ...s })) }));
  const { min, max } = RANGES.setCount;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    problems.push(`${key}: ${min} ile ${max} arasında set içeren bir liste olmalı`);
    return fallback();
  }

  const sets = value.map((item, i) => {
    const at = `${key}[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${at}: nesne olmalı ({ "steps": [{ "name": "STUDY", "minutes": 50 }] })`);
      return makeSet(defaultSetName(i), 1, [makeStep('STUDY', 50)]);
    }
    return makeSet(
      readSetName(item.name, `${at}.name`, i, problems),
      readNumber(item.repeat, `${at}.repeat`, RANGES.repeat, 1, problems),
      readStatuses(item.steps ?? item.statuses, `${at}.steps`, problems),
    );
  });

  const total = flattenSets(sets).length;
  if (total > RANGES.totalSteps.max) {
    problems.push(`${key}: bir turda en fazla ${RANGES.totalSteps.max} adım olabilir (tekrarlar dahil, şu an ${total})`);
  }
  return sets;
}

function readSetName(value, key, index, problems) {
  if (value === undefined || value === null || value === '') return defaultSetName(index);
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value) || value.trim().length > STATUS_NAME_MAX) {
    problems.push(`${key}: en fazla ${STATUS_NAME_MAX} karakterlik tek satırlık bir ad olmalı (boş bırakırsan "${defaultSetName(index)}" olur)`);
    return defaultSetName(index);
  }
  return value.trim();
}

function readKind(value, key, name, problems) {
  if (value === undefined || value === null) return inferKind(name);
  if (!STEP_KINDS.includes(value)) {
    problems.push(`${key}: "work" (çalışma) ya da "break" (mola) olmalı (verilen: ${JSON.stringify(value)})`);
    return inferKind(name);
  }
  return value;
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

/** `sets` varsa o; yoksa `statuses` TEK set olur; o da yoksa eski şekil (iki adımlı tek set). */
function readSets(raw, field, problems) {
  if (raw.sets !== undefined && raw.sets !== null) return readSetList(raw.sets, `${field}.sets`, problems);
  const steps = raw.statuses !== undefined && raw.statuses !== null
    ? readStatuses(raw.statuses, `${field}.statuses`, problems)
    : readLegacyStatuses(raw, field, problems);
  return [makeSet(defaultSetName(0), 1, steps)];
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
    makeStep('STUDY', work),
    makeStep('BREAK', rest, { visual: readVisual(raw.breakClip, `${field}.breakClip`, problems) }),
  ];
}

function readStatuses(value, key, problems) {
  const fallback = POMODORO_DEFAULTS.statuses.map((status) => ({ ...status }));
  const { min, max } = RANGES.statusCount;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    problems.push(`${key}: ${min} ile ${max} arasında adım içeren bir liste olmalı`);
    return fallback;
  }

  return value.map((item, i) => {
    const at = `${key}[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      problems.push(`${at}: nesne olmalı ({ "name": "STUDY", "minutes": 50 })`);
      return makeStep(`DURUM ${i + 1}`, 10);
    }
    const name = readStatusName(item.name, `${at}.name`, i, problems);
    return {
      name,
      minutes: readNumber(item.minutes, `${at}.minutes`, RANGES.minutes, 10, problems),
      visual: readVisual(item.visual, `${at}.visual`, problems),
      beep: readBoolean(item.beep, `${at}.beep`, true, problems),
      kind: readKind(item.kind, `${at}.kind`, name, problems),
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
  const found = POMODORO_PRESETS.find((p) => p.id === value && p.sets.length === 1 && p.statuses.length === 2);
  if (!found) {
    problems.push(
      `${key}: şunlardan biri olmalı: ${POMODORO_PRESETS.filter((p) => p.sets.length === 1 && p.statuses.length === 2).map((p) => `"${p.id}"`).join(', ')} ` +
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
