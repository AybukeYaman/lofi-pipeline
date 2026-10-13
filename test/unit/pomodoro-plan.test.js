/**
 * core/pomodoro-plan.js — saf plan/timeline/karşılaştırma mantığı.
 *
 * Her video 2 dk GET READY ile başlar; bip akışının tamamı "her oturumun son
 * 3 saniyesinde 3 bip" (başlangıç sesi yok). Senaryolar spec'teki sayıların
 * hazırlık süresi eklenmiş hâli: 50/10×4 ve 30/10×6 → 242 dk (240 + 2),
 * 255:00 fazla, 229:30 eksik.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  POMODORO_DEFAULTS,
  POMODORO_PRESETS,
  buildCueEvents,
  buildTimeline,
  compareMusic,
  describeComparison,
  describeTimeline,
  formatClock,
  normalizePomodoroSelection,
  PomodoroValidationError,
  planTrim,
  presetIdFor,
  serializePomodoroPlan,
  validatePomodoro,
} from '../../core/pomodoro-plan.js';

/** Testlerde tekrar eden plan kurulumu. */
function planOf(raw) {
  const { plan, problems } = normalizePomodoroSelection({ enabled: true, ...raw });
  assert.deepEqual(problems, [], 'beklenmeyen doğrulama sorunu');
  return plan;
}

describe('normalizePomodoroSelection', () => {
  it('alan yoksa ya da kapalıysa plan üretmez (Pomodoro OFF)', () => {
    assert.equal(normalizePomodoroSelection(undefined).plan, null);
    assert.equal(normalizePomodoroSelection(null).plan, null);
    assert.equal(normalizePomodoroSelection({ enabled: false }).plan, null);
  });

  it('kapalı blokta geçersiz alanlar build\'i durdurmaz', () => {
    const { plan, problems } = normalizePomodoroSelection({ enabled: false, rounds: 999 });
    assert.equal(plan, null);
    assert.deepEqual(problems, []);
  });

  it('preset work/break dakikalarını doldurur', () => {
    const plan = planOf({ preset: '30/10', rounds: 6 });
    assert.equal(plan.workMinutes, 30);
    assert.equal(plan.breakMinutes, 10);
    assert.equal(plan.rounds, 6);
    assert.equal(plan.preset, '30/10');
  });

  it('elle verilen değerler preseti ezer ve eşleşen preset kimliği taşınır', () => {
    const plan = planOf({ preset: '30/10', workMinutes: 50 });
    assert.equal(plan.workMinutes, 50);
    assert.equal(plan.preset, '50/10');
  });

  it('hazır düzene denk gelmeyen değerde preset null kalır', () => {
    assert.equal(planOf({ workMinutes: 45, breakMinutes: 15 }).preset, null);
  });

  it('varsayılanlar POMODORO_DEFAULTS ile aynı', () => {
    const plan = planOf({});
    assert.equal(plan.countdownSeconds, POMODORO_DEFAULTS.countdownSeconds);
    assert.equal(plan.countdownBeep, POMODORO_DEFAULTS.countdownBeep);
    assert.deepEqual(plan.cue, POMODORO_DEFAULTS.cue);
  });

  it('sorunları tek seferde toplar, hata atmaz', () => {
    const { problems } = normalizePomodoroSelection({
      enabled: true, preset: '25/5', rounds: 0, countdownSeconds: 99, cue: { volumeDb: 'yüksek' },
    });
    assert.equal(problems.length, 4);
    assert.ok(problems.some((p) => p.includes('pomodoro.preset')));
    assert.ok(problems.some((p) => p.includes('pomodoro.rounds')));
    assert.ok(problems.some((p) => p.includes('pomodoro.countdownSeconds')));
    assert.ok(problems.some((p) => p.includes('pomodoro.cue.volumeDb')));
  });

  it('bip dosyası verilebilir, verilmezse üretilen ses için null kalır', () => {
    assert.equal(planOf({ cue: { beepFile: 'C:\\ses\\bip.wav' } }).cue.beepFile, 'C:\\ses\\bip.wav');
    assert.equal(planOf({}).cue.beepFile, null);
  });

  it('eski projelerdeki başlangıç sesi alanları sessizce yok sayılır (proje yüklenir)', () => {
    const { plan, problems } = normalizePomodoroSelection({
      enabled: true, workStartSound: true, breakStartSound: false, cue: { workStartFile: 'x.wav' },
    });
    assert.deepEqual(problems, []);
    assert.equal(Object.hasOwn(plan, 'workStartSound'), false);
    assert.equal(Object.hasOwn(plan.cue, 'workStartFile'), false);
  });
});

describe('buildTimeline', () => {
  it('50/10 × 4 → 242 dakika: 2 dk GET READY + 8 oturum', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 4 }));
    assert.equal(timeline.totalMinutes, 242);
    assert.equal(timeline.sessions.length, 9);
  });

  it('30/10 × 6 → yine 242 dakika (spec Test 4)', () => {
    const timeline = buildTimeline(planOf({ preset: '30/10', rounds: 6 }));
    assert.equal(timeline.totalMinutes, 242);
    assert.equal(timeline.sessions.length, 13);
  });

  it('video her zaman 2 dk GET READY ile başlar, sonra WORK/BREAK boşluksuz dizilir', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 2 }));
    assert.deepEqual(
      timeline.sessions.map((s) => [s.kind, s.label, s.startSeconds / 60, s.endSeconds / 60]),
      [
        ['ready', 'GET READY', 0, 2],
        ['work', 'WORK 01', 2, 52], ['break', 'BREAK 01', 52, 62],
        ['work', 'WORK 02', 62, 112], ['break', 'BREAK 02', 112, 122],
      ],
    );
    assert.deepEqual(timeline.sessions.map((s) => s.index), [0, 1, 2, 3, 4]);
  });

  it('tur sayısı değişince timeline kendiliğinden yeniden kurulur', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 8 }));
    assert.equal(timeline.totalMinutes, 482);
    assert.equal(timeline.sessions.at(-1).label, 'BREAK 08');
  });

  it('describeTimeline GET READY ile başlayan dökümü verir', () => {
    const text = describeTimeline(buildTimeline(planOf({ preset: '50/10', rounds: 4 })));
    assert.ok(text.startsWith('GET READY\n00:00 - 02:00\n\nWORK 01\n02:00 - 52:00\n\nBREAK 01\n52:00 - 62:00'));
    assert.ok(text.trimEnd().endsWith('BREAK 04\n232:00 - 242:00'));
  });
});

describe('buildCueEvents — bip akışının tamamı', () => {
  const plan = planOf({ preset: '50/10', rounds: 2 });
  const timeline = buildTimeline(plan);

  it('GET READY dahil HER oturumun son 3 saniyesinde 3 bip (T-3, T-2, T-1)', () => {
    const { events } = buildCueEvents(plan, timeline);
    const ready = events.filter((e) => e.session === 0);
    assert.deepEqual(ready.map((e) => e.atSeconds), [117, 118, 119]);
    const work1 = events.filter((e) => e.session === 1);
    assert.deepEqual(work1.map((e) => e.atSeconds), [52 * 60 - 3, 52 * 60 - 2, 52 * 60 - 1]);
  });

  it('videonun son oturumunun sonunda da bip var', () => {
    const { events } = buildCueEvents(plan, timeline);
    const last = events.filter((e) => e.session === timeline.sessions.length - 1);
    assert.deepEqual(last.map((e) => e.atSeconds), [122 * 60 - 3, 122 * 60 - 2, 122 * 60 - 1]);
  });

  it('başka ses yok: yalnızca bip, oturum başına tam 3; toplam = oturum × 3', () => {
    const { events } = buildCueEvents(plan, timeline);
    assert.ok(events.every((e) => e.type === 'beep'));
    assert.equal(events.length, timeline.sessions.length * 3);
    for (const session of timeline.sessions) {
      assert.equal(events.filter((e) => e.session === session.index).length, 3);
    }
  });

  it('hiçbir bip videonun başından önceye düşmez (atlanan bip yok)', () => {
    const { events } = buildCueEvents(plan, timeline);
    assert.ok(events.every((e) => e.atSeconds >= 0));
    assert.equal(events[0].atSeconds, 117, 'ilk bip GET READY\'nin 2. dakikasının son 3 saniyesinde');
  });

  it('olaylar zamana göre sıralı döner', () => {
    const { events } = buildCueEvents(plan, timeline);
    const times = events.map((e) => e.atSeconds);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('bip kapatılınca hiç olay üretmez', () => {
    const quiet = planOf({ preset: '50/10', rounds: 2, countdownBeep: false });
    assert.deepEqual(buildCueEvents(quiet, buildTimeline(quiet)).events, []);
  });

  it('countdownSeconds geri sayımın uzunluğunu belirler', () => {
    const two = planOf({ preset: '50/10', rounds: 1, countdownSeconds: 2 });
    const { events } = buildCueEvents(two, buildTimeline(two));
    assert.deepEqual(events.filter((e) => e.session === 0).map((e) => e.atSeconds), [118, 119]);
  });
});

describe('compareMusic', () => {
  const plan = planOf({ preset: '50/10', rounds: 4 });
  const timeline = buildTimeline(plan);

  it('Test 1 — müzik timeline\'a eşitse doğrulama geçer', () => {
    const result = compareMusic({ musicSeconds: 242 * 60, timeline });
    assert.equal(result.status, 'exact');
    assert.equal(result.ok, true);
    assert.equal(result.excessSeconds, 0);
    assert.equal(result.shortSeconds, 0);
  });

  it('saniyenin altındaki toplama sapması eşit sayılır', () => {
    assert.equal(compareMusic({ musicSeconds: 242 * 60 + 0.4, timeline }).status, 'exact');
  });

  it('Test 2 — 13 dakika fazla', () => {
    const result = compareMusic({ musicSeconds: 255 * 60, timeline });
    assert.equal(result.status, 'excess');
    assert.equal(result.ok, false);
    assert.equal(result.excessSeconds, 13 * 60);
    assert.ok(describeComparison(result, plan).includes('Fazla: 13:00'));
  });

  it('Test 3 — 12:30 eksik', () => {
    const result = compareMusic({ musicSeconds: 229.5 * 60, timeline });
    assert.equal(result.status, 'short');
    assert.equal(result.ok, false);
    assert.equal(result.shortSeconds, 12.5 * 60);
    const text = describeComparison(result, plan);
    assert.ok(text.includes('Eksik: 12:30'));
    assert.ok(text.includes('Pomodoro timeline: 242:00'));
    assert.ok(text.includes('2 dk hazırlık'));
    assert.ok(text.includes('Müzik toplamı: 229:30'));
  });
});

describe('planTrim', () => {
  it('son parçayı track sınırını koruyarak gereken kadarına indirir', () => {
    const tracks = [
      { path: 'a.m4a', duration: 600 },
      { path: 'b.m4a', duration: 600 },
      { path: 'c.m4a', duration: 522 }, // 08:42
    ];
    // 10:00 + 10:00 + 03:17 = 23:17
    const result = planTrim(tracks, 600 + 600 + 197);

    assert.deepEqual(result.tracks.map((t) => t.usedDuration), [600, 600, 197]);
    assert.deepEqual(result.tracks.map((t) => t.trimmed), [false, false, true]);
    assert.equal(result.trimmedSeconds, 325);
    assert.equal(result.trimmedCount, 1);
    assert.equal(result.droppedCount, 0);
  });

  it('timeline\'dan sonra başlayan parçalar hiç kullanılmaz', () => {
    const tracks = [{ path: 'a', duration: 300 }, { path: 'b', duration: 300 }, { path: 'c', duration: 300 }];
    const result = planTrim(tracks, 420);
    assert.deepEqual(result.tracks.map((t) => t.usedDuration), [300, 120, 0]);
    assert.deepEqual(result.tracks.map((t) => t.dropped), [false, false, true]);
    assert.equal(result.droppedCount, 1);
    assert.equal(result.usedSeconds, 420);
  });

  it('tam sığan seçimde hiçbir parçaya dokunmaz', () => {
    const tracks = [{ path: 'a', duration: 300 }, { path: 'b', duration: 300 }];
    const result = planTrim(tracks, 600);
    assert.equal(result.trimmedSeconds, 0);
    assert.equal(result.trimmedCount, 0);
    assert.equal(result.droppedCount, 0);
  });

  it('başlangıç damgaları kullanılan sürelerden türer', () => {
    const tracks = [{ path: 'a', duration: 300 }, { path: 'b', duration: 300 }];
    assert.deepEqual(planTrim(tracks, 450).tracks.map((t) => t.startSeconds), [0, 300]);
  });
});

describe('validatePomodoro', () => {
  /** Verilen toplam süreyi eşit parçalara bölen sahte seçim. */
  const tracksOf = (total, count = 4) =>
    Array.from({ length: count }, (_, i) => ({ path: `t${i}.m4a`, duration: total / count }));

  it('Pomodoro kapalıyken hiçbir şey doğrulamaz (OFF geriye dönük uyumlu)', () => {
    const result = validatePomodoro({ plan: null, tracks: [] });
    assert.deepEqual(
      { enabled: result.enabled, ok: result.ok, timeline: result.timeline, problems: result.problems },
      { enabled: false, ok: true, timeline: null, problems: [] },
    );
  });

  it('Test 1 — müzik tam oturursa geçer, kırpma planı üretilmez', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(242 * 60) });
    assert.equal(result.ok, true);
    assert.equal(result.comparison.status, 'exact');
    assert.equal(result.trim, null);
    assert.equal(result.timeline.totalMinutes, 242);
  });

  it('Test 2 — fazla müzik montajı ENGELLEMEZ: soru sormaz, uyarır ve kırpma planını hazırlar', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(255 * 60) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(Object.hasOwn(result, 'needsTrimConfirmation'), false, 'onay kavramı kalmadı');
    assert.equal(result.trim.trimmedSeconds, 13 * 60);
    assert.equal(result.trim.usedSeconds, 242 * 60);
    assert.ok(result.warnings.some((w) => w.includes('13:00') && w.includes('otomatik kırpılacak')));
  });

  it('fazla müzik uyarısı kullanılmayacak parçaları ve Geri Dönüşüm Kutusu\'nu söyler', () => {
    // 10 parça × 30 dk = 300 dk, timeline 242 dk: 9. parça kısalır, 10. parça tamamen dışarıda kalır.
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(300 * 60, 10) });
    const warning = result.warnings.find((w) => w.includes('otomatik kırpılacak'));
    assert.ok(result.trim.droppedCount >= 1, 'bu senaryoda en az bir parça tamamen dışarıda kalmalı');
    assert.match(warning, /kullanılmayacak/);
    assert.match(warning, /Geri Dönüşüm Kutusu/);
  });

  it('eski project.json\'daki trimExcess alanı sessizce yok sayılır (proje yüklenir)', () => {
    const { plan, problems } = normalizePomodoroSelection({ enabled: true, trimExcess: true });
    assert.deepEqual(problems, []);
    assert.equal(Object.hasOwn(plan, 'trimExcess'), false);
    assert.equal(Object.hasOwn(serializePomodoroPlan(plan), 'trimExcess'), false);
  });

  it('Test 3 — eksik müzik engel DEĞİL: uyarır, kalan süreyi arka plan sesi doldurur', () => {
    const plan = planOf({ preset: '50/10', rounds: 4 });
    const result = validatePomodoro({ plan, tracks: tracksOf(229.5 * 60) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(result.comparison.status, 'short');
    assert.equal(result.trim, null, 'eksik müzikte kırpılacak bir şey yok');
    assert.ok(result.warnings.some((w) => w.includes('12:30') && w.includes('Ambiance')));
    assert.match(result.message, /Eksik: 12:30/);
    assert.match(result.message, /Ambiance/);
  });

  it('çok eksik müzik de engel değil (hiç müzik olmasa bile yalnızca ölçülemeyen parça durdurur)', () => {
    const plan = planOf({ preset: '50/10', rounds: 2 });
    assert.equal(validatePomodoro({ plan, tracks: [] }).ok, true);
    assert.equal(validatePomodoro({ plan, tracks: [{ path: 'x.m4a', duration: null }] }).ok, false);
  });

  it('ölçülemeyen parça montajı durdurur', () => {
    const result = validatePomodoro({
      plan: planOf({ preset: '50/10', rounds: 4 }),
      tracks: [{ path: 'bozuk.m4a', duration: null }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('ölçülemedi')));
  });

  it('bipler hiçbir uyarı üretmez: hepsi videonun içine düşer', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(242 * 60) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.cues.events.length, 9 * 3);
  });

  it('PomodoroValidationError mesajı sayıları ve sorunları taşır', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(229.5 * 60) });
    const error = new PomodoroValidationError(result);
    assert.equal(error.name, 'PomodoroValidationError');
    assert.ok(error.message.includes('Müzik toplamı: 229:30'));
    assert.ok(error.message.includes('12:30'));
    assert.equal(error.validation, result);
  });
});

describe('breakClip (mola görüntüsü)', () => {
  it('varsayılan null: mola da çalışma görüntüsünü kullanır', () => {
    assert.equal(planOf({}).breakClip, null);
    assert.equal(POMODORO_DEFAULTS.breakClip, null);
  });

  it('verilen yol plana geçer', () => {
    assert.equal(planOf({ breakClip: 'resimler/mola.png' }).breakClip, 'resimler/mola.png');
  });

  it('boş ya da metin olmayan değer anlaşılır hata verir', () => {
    for (const bad of ['', '  ', 5, {}]) {
      const { problems } = normalizePomodoroSelection({ enabled: true, breakClip: bad });
      assert.equal(problems.length, 1, JSON.stringify(bad));
      assert.match(problems[0], /pomodoro\.breakClip/);
    }
  });

  it('Pomodoro kapalıyken doğrulanmaz', () => {
    assert.deepEqual(normalizePomodoroSelection({ enabled: false, breakClip: 5 }).problems, []);
  });
});

describe('formatClock', () => {
  it('dakikayı saate çevirmez', () => {
    assert.equal(formatClock(240 * 60), '240:00');
    assert.equal(formatClock(197), '03:17');
    assert.equal(formatClock(522), '08:42');
    assert.equal(formatClock(0), '00:00');
  });
});

describe('serializePomodoroPlan', () => {
  it('varsayılandan sapmayan alanı yazmaz', () => {
    const written = serializePomodoroPlan(planOf({ preset: '50/10', rounds: 4 }));
    assert.deepEqual(written, {
      enabled: true, preset: '50/10', workMinutes: 50, breakMinutes: 10, rounds: 4,
    });
  });

  it('sapan alanları ve cue ayarlarını yazar', () => {
    const written = serializePomodoroPlan(planOf({
      preset: '30/10', rounds: 6, countdownBeep: false, cue: { volumeDb: -6 },
    }));
    assert.equal(written.countdownBeep, false);
    assert.deepEqual(written.cue, { volumeDb: -6 });
  });

  it('plan yoksa anahtar silinir', () => {
    assert.equal(serializePomodoroPlan(null), undefined);
  });

  it('mola görüntüsü yazılır, yoksa hiç yazılmaz', () => {
    assert.equal('breakClip' in serializePomodoroPlan(planOf({ preset: '50/10' })), false);
    assert.equal(
      serializePomodoroPlan(planOf({ preset: '50/10', breakClip: 'videolar/mola.mp4' })).breakClip,
      'videolar/mola.mp4',
    );
  });

  it('yazılan şekil geri okunduğunda aynı planı verir', () => {
    const plan = planOf({ preset: '30/10', rounds: 6, cue: { volumeDb: -6 } });
    const { plan: reread, problems } = normalizePomodoroSelection(serializePomodoroPlan(plan));
    assert.deepEqual(problems, []);
    assert.deepEqual(reread, plan);
  });
});

describe('presetIdFor', () => {
  it('hazır düzenleri tanır', () => {
    for (const preset of POMODORO_PRESETS) {
      assert.equal(presetIdFor(preset.workMinutes, preset.breakMinutes), preset.id);
    }
    assert.equal(presetIdFor(45, 15), null);
  });
});
