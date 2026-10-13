/**
 * core/pomodoro-plan.js — saf plan/timeline/karşılaştırma mantığı.
 *
 * Her video 2 dk GET READY ile başlar; bip akışının tamamı "her oturumun son
 * 3 saniyesinde 3 bip" (başlangıç sesi yok). Senaryolar spec'teki sayıların
 * hazırlık süresi eklenmiş, sondaki mola düşmüş hâli: 50/10×4 ve 30/10×6 → 232 dk (240 + 2 − 10),
 * 245:00 fazla, 219:30 eksik.
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
  describeCycle,
  describeTimeline,
  formatClock,
  legacyKeysIn,
  normalizePomodoroSelection,
  PomodoroValidationError,
  planTrim,
  flattenSets,
  inferKind,
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

  it('eski preset durum dakikalarını doldurur', () => {
    const plan = planOf({ preset: '30/10', rounds: 6 });
    assert.deepEqual(plan.statuses.map((x) => [x.name, x.minutes]), [['STUDY', 30], ['BREAK', 10]]);
    assert.equal(plan.rounds, 6);
    assert.equal(plan.preset, '30/10');
  });

  it('eski elle verilen değerler preseti ezer ve eşleşen preset kimliği taşınır', () => {
    const plan = planOf({ preset: '30/10', workMinutes: 50 });
    assert.deepEqual(plan.statuses.map((x) => x.minutes), [50, 10]);
    assert.equal(plan.preset, '50/10');
  });

  it('hazır düzene denk gelmeyen değerde preset null kalır', () => {
    assert.equal(planOf({ workMinutes: 45, breakMinutes: 15 }).preset, null);
    assert.equal(planOf({ statuses: [{ name: 'A', minutes: 45 }, { name: 'B', minutes: 15 }] }).preset, null);
  });

  it('plan geçici/eski alanları taşımaz: yalnızca statuses', () => {
    const plan = planOf({ preset: '50/10', breakClip: 'x.png' });
    for (const old of ['workMinutes', 'breakMinutes', 'breakClip']) assert.equal(old in plan, false);
  });

  it('legacyKeysIn eski anahtarları bulur, yenilerini bulmaz', () => {
    assert.deepEqual(legacyKeysIn({ enabled: true, preset: '50/10', breakClip: '' }), ['preset', 'breakClip']);
    assert.deepEqual(legacyKeysIn({ enabled: true, statuses: [], intro: {} }), []);
    assert.deepEqual(legacyKeysIn(null), []);
    assert.deepEqual(legacyKeysIn([]), []);
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
  it('50/10 × 4 → 232 dakika: 2 dk GET READY + 7 oturum (video molayla bitmez)', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 4 }));
    assert.equal(timeline.totalMinutes, 232);
    assert.equal(timeline.sessions.length, 8);
    assert.deepEqual(timeline.droppedTail, [{ name: 'BREAK', minutes: 10 }]);
  });

  it('30/10 × 6 → 232 dakika (son BREAK videoya girmez)', () => {
    const timeline = buildTimeline(planOf({ preset: '30/10', rounds: 6 }));
    assert.equal(timeline.totalMinutes, 232);
    assert.equal(timeline.sessions.length, 12);
  });

  it('video her zaman 2 dk GET READY ile başlar, sonra STUDY/BREAK boşluksuz dizilir', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 2 }));
    assert.deepEqual(
      timeline.sessions.map((s) => [s.kind, s.label, s.startSeconds / 60, s.endSeconds / 60]),
      [
        ['ready', 'GET READY', 0, 2],
        ['status', 'STUDY 01', 2, 52], ['status', 'BREAK 01', 52, 62],
        ['status', 'STUDY 02', 62, 112],
      ],
    );
    assert.deepEqual(timeline.sessions.map((s) => s.index), [0, 1, 2, 3]);
  });

  it('tur sayısı değişince timeline kendiliğinden yeniden kurulur', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 8 }));
    assert.equal(timeline.totalMinutes, 472);
    assert.equal(timeline.sessions.at(-1).label, 'STUDY 08');
  });

  it('describeTimeline GET READY ile başlayan dökümü verir', () => {
    const text = describeTimeline(buildTimeline(planOf({ preset: '50/10', rounds: 4 })));
    assert.ok(text.startsWith('GET READY\n00:00 - 02:00\n\nSTUDY 01\n02:00 - 52:00\n\nBREAK 01\n52:00 - 62:00'));
    assert.ok(text.trimEnd().endsWith('STUDY 04\n182:00 - 232:00'));
  });
});

describe('özel durumlar (statuses)', () => {
  const stretch = [
    { name: 'STUDY', minutes: 25 },
    { name: 'STRETCH', minutes: 5, visual: './resimler/esneme.png' },
    { name: 'LONG BREAK', minutes: 10, beep: false },
  ];

  it('döngü sırayla tekrarlanır; her oturum adını, sırasını, görüntüsünü ve bipini taşır', () => {
    const timeline = buildTimeline(planOf({ statuses: stretch, rounds: 2, intro: { visual: './resimler/hazir.png' } }));
    // STRETCH ve LONG BREAK ikisi de mola: son turun sonundaki ikisi de videoya girmez.
    assert.equal(timeline.totalMinutes, 2 + 2 * 40 - 15);
    assert.deepEqual(
      timeline.sessions.map((x) => [x.name, x.statusIndex, x.round, x.visual, x.beep]),
      [
        ['GET READY', -1, 0, './resimler/hazir.png', true],
        ['STUDY', 0, 1, null, true], ['STRETCH', 1, 1, './resimler/esneme.png', true], ['LONG BREAK', 2, 1, null, false],
        ['STUDY', 0, 2, null, true],
      ],
    );
    assert.deepEqual(timeline.droppedTail, [{ name: 'STRETCH', minutes: 5 }, { name: 'LONG BREAK', minutes: 10 }]);
    assert.equal(timeline.sessions[2].label, 'STRETCH 01');
  });

  it('beep: false olan durumun bitişinde bip çalmaz, öbürleri çalar', () => {
    const plan = planOf({ statuses: stretch, rounds: 2 });
    const { events } = buildCueEvents(plan, buildTimeline(plan));
    const sessions = new Set(events.map((e) => e.session));
    // 3 = LONG BREAK 01 (beep: false) atlanır; videonun son oturumu STUDY 02 (4).
    assert.deepEqual([...sessions].sort(), [0, 1, 2, 4]);
    assert.equal(events.length, 12);
  });

  it('eski şekil iki durumlu listeye çevrilir; breakClip BREAK görüntüsü olur', () => {
    const plan = planOf({ preset: '50/10', breakClip: 'videolar/mola.mp4' });
    assert.deepEqual(plan.statuses, [
      { name: 'STUDY', minutes: 50, visual: null, beep: true, kind: 'work' },
      { name: 'BREAK', minutes: 10, visual: 'videolar/mola.mp4', beep: true, kind: 'break' },
    ]);
    assert.equal(plan.preset, '50/10');
    assert.deepEqual(plan.sets.map((set) => [set.name, set.repeat, set.steps.length]), [['SET 1', 1, 2]]);
  });

  it('statuses varsa eski alanlar yok sayılır', () => {
    const plan = planOf({ statuses: [{ name: 'A', minutes: 7 }], workMinutes: 50, preset: '30/10' });
    assert.deepEqual(plan.statuses.map((x) => [x.name, x.minutes]), [['A', 7]]);
    assert.equal(plan.preset, null);
  });

  it('geçersiz durumlar anlaşılır hata verir', () => {
    const cases = [
      [[], /pomodoro\.statuses/],
      ['x', /pomodoro\.statuses/],
      [[{ name: '', minutes: 5 }], /statuses\[0\]\.name/],
      [[{ name: 'A'.repeat(25), minutes: 5 }], /statuses\[0\]\.name.*24/],
      [[{ name: 'A\nB', minutes: 5 }], /statuses\[0\]\.name/],
      [[{ name: 'A', minutes: 0 }], /statuses\[0\]\.minutes/],
      [[{ name: 'A', minutes: 5, beep: 'evet' }], /statuses\[0\]\.beep/],
      [[{ name: 'A', minutes: 5, visual: '' }], /statuses\[0\]\.visual/],
      [[5], /statuses\[0\]: nesne/],
    ];
    for (const [statuses, pattern] of cases) {
      const { problems } = normalizePomodoroSelection({ enabled: true, statuses });
      assert.ok(problems.some((p) => pattern.test(p)), JSON.stringify(statuses) + ' → ' + problems.join(' | '));
    }
  });

  it('describeCycle sürelerle özetler', () => {
    assert.equal(describeCycle(planOf({ statuses: stretch }).statuses), '25/5/10');
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
    // Video son STUDY ile biter (son BREAK videoya girmez): bip 112. dakikanın sonunda.
    assert.equal(timeline.sessions.at(-1).label, 'STUDY 02');
    assert.deepEqual(last.map((e) => e.atSeconds), [112 * 60 - 3, 112 * 60 - 2, 112 * 60 - 1]);
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
    const result = compareMusic({ musicSeconds: 232 * 60, timeline });
    assert.equal(result.status, 'exact');
    assert.equal(result.ok, true);
    assert.equal(result.excessSeconds, 0);
    assert.equal(result.shortSeconds, 0);
  });

  it('saniyenin altındaki toplama sapması eşit sayılır', () => {
    assert.equal(compareMusic({ musicSeconds: 232 * 60 + 0.4, timeline }).status, 'exact');
  });

  it('Test 2 — 13 dakika fazla', () => {
    const result = compareMusic({ musicSeconds: 245 * 60, timeline });
    assert.equal(result.status, 'excess');
    assert.equal(result.ok, false);
    assert.equal(result.excessSeconds, 13 * 60);
    assert.ok(describeComparison(result, plan).includes('Fazla: 13:00'));
  });

  it('Test 3 — 12:30 eksik', () => {
    const result = compareMusic({ musicSeconds: 219.5 * 60, timeline });
    assert.equal(result.status, 'short');
    assert.equal(result.ok, false);
    assert.equal(result.shortSeconds, 12.5 * 60);
    const text = describeComparison(result, plan);
    assert.ok(text.includes('Eksik: 12:30'));
    assert.ok(text.includes('Pomodoro timeline: 232:00'));
    assert.ok(text.includes('2 dk hazırlık − sondaki BREAK 10 dk'));
    assert.ok(text.includes('Müzik toplamı: 219:30'));
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
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(232 * 60) });
    assert.equal(result.ok, true);
    assert.equal(result.comparison.status, 'exact');
    assert.equal(result.trim, null);
    assert.equal(result.timeline.totalMinutes, 232);
  });

  it('Test 2 — fazla müzik montajı ENGELLEMEZ: soru sormaz, uyarır ve kırpma planını hazırlar', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(245 * 60) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.problems, []);
    assert.equal(Object.hasOwn(result, 'needsTrimConfirmation'), false, 'onay kavramı kalmadı');
    assert.equal(result.trim.trimmedSeconds, 13 * 60);
    assert.equal(result.trim.usedSeconds, 232 * 60);
    assert.ok(result.warnings.some((w) => w.includes('13:00') && w.includes('otomatik kırpılacak')));
  });

  it('fazla müzik uyarısı kullanılmayacak parçaları ve Geri Dönüşüm Kutusu\'nu söyler', () => {
    // 10 parça × 30 dk = 300 dk, timeline 232 dk: 9. parça kısalır, 10. parça tamamen dışarıda kalır.
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
    const result = validatePomodoro({ plan, tracks: tracksOf(219.5 * 60) });
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
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(232 * 60) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.cues.events.length, 8 * 3);
  });

  it('PomodoroValidationError mesajı sayıları ve sorunları taşır', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(219.5 * 60) });
    const error = new PomodoroValidationError(result);
    assert.equal(error.name, 'PomodoroValidationError');
    assert.ok(error.message.includes('Müzik toplamı: 219:30'));
    assert.ok(error.message.includes('12:30'));
    assert.equal(error.validation, result);
  });
});

describe('görüntü yolları (visual)', () => {
  it('varsayılan null: durum da ana görüntüyü (clip) kullanır', () => {
    const plan = planOf({});
    assert.deepEqual(plan.statuses.map((x) => x.visual), [null, null]);
    assert.equal(plan.intro.visual, null);
  });

  it('verilen yol plana geçer (eski breakClip BREAK görüntüsü olur)', () => {
    assert.equal(planOf({ breakClip: 'resimler/mola.png' }).statuses[1].visual, 'resimler/mola.png');
    assert.equal(planOf({ intro: { visual: 'resimler/hazir.png' } }).intro.visual, 'resimler/hazir.png');
  });

  it('boş ya da metin olmayan değer anlaşılır hata verir', () => {
    for (const bad of ['', '  ', 5, {}]) {
      const { problems } = normalizePomodoroSelection({ enabled: true, breakClip: bad });
      assert.equal(problems.length, 1, JSON.stringify(bad));
      assert.match(problems[0], /pomodoro\.breakClip/);
    }
    assert.match(normalizePomodoroSelection({ enabled: true, intro: { visual: '' } }).problems[0], /intro\.visual/);
    assert.match(normalizePomodoroSelection({ enabled: true, intro: 3 }).problems[0], /intro/);
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
      enabled: true,
      rounds: 4,
      statuses: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }],
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

  it('görüntü ve bip kapalı yalnızca verildiyse yazılır; eski alanlar hiç yazılmaz', () => {
    const plain = serializePomodoroPlan(planOf({ preset: '50/10' }));
    assert.deepEqual(Object.keys(plain).sort(), ['enabled', 'rounds', 'statuses']);
    assert.deepEqual(plain.statuses[1], { name: 'BREAK', minutes: 10 });

    const custom = serializePomodoroPlan(planOf({
      statuses: [{ name: 'STUDY', minutes: 50, beep: false }, { name: 'BREAK', minutes: 10, visual: 'videolar/mola.mp4' }],
      intro: { visual: 'resimler/hazir.png' },
    }));
    assert.deepEqual(custom.statuses, [
      { name: 'STUDY', minutes: 50, beep: false },
      { name: 'BREAK', minutes: 10, visual: 'videolar/mola.mp4' },
    ]);
    assert.deepEqual(custom.intro, { visual: 'resimler/hazir.png' });
    for (const old of ['preset', 'workMinutes', 'breakMinutes', 'breakClip']) assert.equal(old in custom, false);
  });

  it('eski şekilde yazılmış plan geri yazılınca yalnızca statuses olur', () => {
    const written = serializePomodoroPlan(planOf({
      workMinutes: 30, breakMinutes: 10, breakClip: 'resimler/mola.png', rounds: 3,
    }));
    assert.deepEqual(written, {
      enabled: true,
      rounds: 3,
      statuses: [{ name: 'STUDY', minutes: 30 }, { name: 'BREAK', minutes: 10, visual: 'resimler/mola.png' }],
    });
  });

  it('yazılan şekil geri okunduğunda aynı planı verir', () => {
    const plan = planOf({
      rounds: 6,
      cue: { volumeDb: -6 },
      statuses: [{ name: 'STUDY', minutes: 25 }, { name: 'STRETCH', minutes: 5, beep: false, visual: 'a.png' }],
      intro: { visual: 'b.png' },
    });
    const { plan: reread, problems } = normalizePomodoroSelection(serializePomodoroPlan(plan));
    assert.deepEqual(problems, []);
    assert.deepEqual(reread, plan);
  });
});

describe('presetIdFor', () => {
  it('hazır düzenleri tanır', () => {
    for (const preset of POMODORO_PRESETS) {
      assert.equal(presetIdFor(preset.statuses), preset.id);
    }
    assert.equal(presetIdFor([{ minutes: 45 }, { minutes: 15 }]), null);
    assert.equal(presetIdFor([{ minutes: 50 }, { minutes: 10 }, { minutes: 5 }]), null);
  });
});

describe('adım → set → loop', () => {
  const longBreak = [
    { name: 'SET 1', steps: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }] },
    { name: 'SET 2', steps: [{ name: 'STUDY', minutes: 50 }, { name: 'LONG BREAK', minutes: 20 }] },
  ];

  it('iki çalışmadan sonra uzun mola: 50/10/50/20 x 2 tur sırası, sayaçlar ve toplam', () => {
    const plan = planOf({ sets: longBreak, rounds: 2 });
    const { sessions, totalSeconds } = buildTimeline(plan);
    const steps = sessions.slice(1);

    // Son LONG BREAK videoya girmez: video STUDY 04 ile biter.
    assert.deepEqual(sessions.map((s) => s.label), [
      'GET READY', 'STUDY 01', 'BREAK 01', 'STUDY 02', 'LONG BREAK 01',
      'STUDY 03', 'BREAK 02', 'STUDY 04',
    ]);
    assert.deepEqual(steps.map((s) => s.durationSeconds / 60), [50, 10, 50, 20, 50, 10, 50]);
    assert.deepEqual(steps.map((s) => s.round), [1, 1, 1, 1, 2, 2, 2]);
    assert.deepEqual(steps.map((s) => s.setIndex), [0, 0, 1, 1, 0, 0, 1]);
    assert.deepEqual(steps.map((s) => s.statusIndex), [0, 1, 2, 3, 0, 1, 2]);
    assert.deepEqual(steps.map((s) => s.stepKind), ['work', 'break', 'work', 'break', 'work', 'break', 'work']);
    assert.equal(sessions[0].stepKind, 'ready');
    assert.equal(totalSeconds, 120 + (2 * 130 - 20) * 60);
    for (let i = 1; i < sessions.length; i++) assert.equal(sessions[i].startSeconds, sessions[i - 1].endSeconds);
    assert.equal(plan.preset, '50/10/50/20');
  });

  it('set tekrarı (repeat) set içinde art arda açılır, sonra sıradaki sete geçilir', () => {
    const plan = planOf({
      sets: [
        { repeat: 3, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }] },
        { steps: [{ name: 'STUDY', minutes: 25 }, { name: 'LONG BREAK', minutes: 15 }] },
      ],
      rounds: 1,
    });
    const { sessions, totalSeconds } = buildTimeline(plan);
    const steps = sessions.slice(1);

    assert.deepEqual(steps.map((s) => [s.name, s.setName, s.repeat]), [
      ['STUDY', 'SET 1', 1], ['BREAK', 'SET 1', 1], ['STUDY', 'SET 1', 2], ['BREAK', 'SET 1', 2],
      ['STUDY', 'SET 1', 3], ['BREAK', 'SET 1', 3], ['STUDY', 'SET 2', 1],
    ]);
    assert.equal(steps.at(-1).label, 'STUDY 04');
    assert.equal(totalSeconds, 120 + (3 * 30 + 25) * 60);
    assert.equal(plan.statuses.length, 8, 'statuses = bir turun açılmış listesi');
    assert.equal(plan.preset, 'Klasik 25/5');
  });

  it('video hiçbir zaman molayla bitmez: sondaki art arda molaların hepsi düşer, öncekiler kalır', () => {
    const plan = planOf({
      sets: [{ steps: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5 }, { name: 'WALK', minutes: 10 }] }],
      rounds: 2,
    });
    const timeline = buildTimeline(plan);
    assert.deepEqual(timeline.sessions.map((s) => s.label), ['GET READY', 'STUDY 01', 'BREAK 01', 'WALK 01', 'STUDY 02']);
    assert.deepEqual(timeline.droppedTail, [{ name: 'BREAK', minutes: 5 }, { name: 'WALK', minutes: 10 }]);
    assert.equal(timeline.totalMinutes, 2 + 40 + 25);
    // Bipler de düşen oturumları içermez; videonun son biti son çalışmanın sonunda.
    const { events } = buildCueEvents(plan, timeline);
    assert.equal(events.at(-1).atSeconds, timeline.totalSeconds - 1);
  });

  it('program çalışmayla bitiyorsa ya da hiç çalışma yoksa hiçbir şey düşmez', () => {
    const endsWithWork = buildTimeline(planOf({ statuses: [{ name: 'BREAK', minutes: 5 }, { name: 'STUDY', minutes: 25 }], rounds: 2 }));
    assert.deepEqual(endsWithWork.droppedTail, []);
    assert.equal(endsWithWork.totalMinutes, 2 + 60);
    const onlyBreaks = buildTimeline(planOf({ statuses: [{ name: 'BREAK', minutes: 5 }], rounds: 2 }));
    assert.deepEqual(onlyBreaks.droppedTail, []);
    assert.equal(onlyBreaks.totalMinutes, 2 + 10);
  });

  it('flattenSets görüntüyü ve bipi kopyalar; kopyalar birbirinden bağımsız', () => {
    const flat = flattenSets([{ repeat: 2, steps: [{ name: 'A', minutes: 5, visual: 'x.png', beep: false, kind: 'work' }] }]);
    assert.deepEqual(flat.map((s) => [s.visual, s.beep]), [['x.png', false], ['x.png', false]]);
    flat[0].name = 'B';
    assert.equal(flat[1].name, 'A');
  });

  it('adım bipi ve görüntüsü her tekrarda geçerli', () => {
    const plan = planOf({
      sets: [{ repeat: 2, steps: [{ name: 'STUDY', minutes: 5 }, { name: 'REST', minutes: 1, beep: false, visual: 'r.png' }] }],
      rounds: 1,
    });
    const timeline = buildTimeline(plan);
    // Son REST videoya girmez; ilk turdaki REST görüntüsünü ve sessizliğini taşır.
    assert.deepEqual(timeline.sessions.map((s) => s.visual), [null, null, 'r.png', null]);
    const { events } = buildCueEvents(plan, timeline);
    assert.deepEqual([...new Set(events.map((e) => e.session))], [0, 1, 3]);
  });

  it('sınırlar: set sayısı, set başına adım, tur başına toplam adım, tekrar, tür, ad', () => {
    const step = { name: 'A', minutes: 5 };
    const many = (count, item) => Array.from({ length: count }, () => item);
    const cases = [
      [[], /pomodoro\.sets: 1 ile 6/],
      [many(7, { steps: [step] }), /pomodoro\.sets: 1 ile 6/],
      [[{ steps: many(9, step) }], /sets\[0\]\.steps: 1 ile 8 arasında adım/],
      [[{ steps: [] }], /sets\[0\]\.steps/],
      [[{ repeat: 5, steps: many(5, step) }], /en fazla 24 adım.*25/],
      [[{ repeat: 0, steps: [step] }], /sets\[0\]\.repeat: 1 ile 10/],
      [[{ repeat: 11, steps: [step] }], /sets\[0\]\.repeat/],
      [[{ steps: [{ ...step, kind: 'nap' }] }], /sets\[0\]\.steps\[0\]\.kind/],
      [[{ name: 'S'.repeat(25), steps: [step] }], /sets\[0\]\.name/],
      [[{ name: 'A\nB', steps: [step] }], /sets\[0\]\.name/],
      [[5], /sets\[0\]: nesne/],
    ];
    for (const [sets, pattern] of cases) {
      const { problems } = normalizePomodoroSelection({ enabled: true, sets });
      assert.ok(problems.some((p) => pattern.test(p)), JSON.stringify(sets).slice(0, 80) + ' → ' + problems.join(' | '));
    }
    // Sınırın tam kendisi geçerli: 6 set; 3 set x 8 adım = 24.
    assert.deepEqual(normalizePomodoroSelection({ enabled: true, sets: many(6, { steps: [step] }) }).problems, []);
    assert.deepEqual(normalizePomodoroSelection({ enabled: true, sets: many(3, { steps: many(8, step) }) }).problems, []);
  });

  it('okuma önceliği: sets > statuses > eski şekil; son ikisi tek set olur', () => {
    assert.equal(planOf({ sets: longBreak, statuses: [{ name: 'X', minutes: 3 }] }).sets.length, 2);
    const flat = planOf({ statuses: [{ name: 'X', minutes: 3 }] });
    assert.deepEqual(flat.sets.map((set) => [set.name, set.repeat, set.steps.map((s) => s.name)]), [['SET 1', 1, ['X']]]);
    const legacy = planOf({ workMinutes: 40, breakMinutes: 8 });
    assert.deepEqual(legacy.sets[0].steps.map((s) => [s.name, s.minutes, s.kind]), [['STUDY', 40, 'work'], ['BREAK', 8, 'break']]);
  });

  it('set içinde steps yerine statuses yazılmışsa da okunur', () => {
    assert.equal(planOf({ sets: [{ statuses: [{ name: 'A', minutes: 4 }] }] }).sets[0].steps[0].minutes, 4);
  });

  it('tür addan tahmin edilir; açık tür tahmini ezer', () => {
    for (const name of ['BREAK', 'Long Break', 'MOLA', 'Uzun Ara', 'STRETCH', 'Yürüyüş', 'rest', 'Nefes']) {
      assert.equal(inferKind(name), 'break', name);
    }
    for (const name of ['STUDY', 'Araştırma', 'READ', 'Odak', 'Kodlama']) {
      assert.equal(inferKind(name), 'work', name);
    }
    assert.equal(planOf({ statuses: [{ name: 'STUDY', minutes: 5, kind: 'break' }] }).statuses[0].kind, 'break');
  });
});

describe('serializePomodoroPlan — setler', () => {
  const roundTrip = (raw) => {
    const plan = planOf(raw);
    const written = serializePomodoroPlan(plan);
    return { plan, written, again: planOf(written) };
  };

  it('tek, varsayılan adlı, tekrarı 1 olan set statuses kısayoluyla yazılır', () => {
    const { written } = roundTrip({ sets: [{ name: 'SET 1', repeat: 1, steps: [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }] }] });
    assert.deepEqual(written.statuses, [{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }]);
    assert.equal(written.sets, undefined);
  });

  it('çoklu set, tekrarlı ya da adlı tek set sets olarak yazılır; varsayılan ad ve tekrar yazılmaz', () => {
    assert.deepEqual(roundTrip({ sets: [{ repeat: 2, steps: [{ name: 'A', minutes: 5 }] }] }).written.sets, [
      { repeat: 2, steps: [{ name: 'A', minutes: 5 }] },
    ]);
    assert.deepEqual(roundTrip({ sets: [{ name: 'Sabah', steps: [{ name: 'A', minutes: 5 }] }] }).written.sets, [
      { name: 'Sabah', steps: [{ name: 'A', minutes: 5 }] },
    ]);
    const { written } = roundTrip({
      sets: [
        { steps: [{ name: 'STUDY', minutes: 50 }] },
        { name: 'Son', repeat: 3, steps: [{ name: 'STUDY', minutes: 50, kind: 'break', beep: false, visual: 'v.png' }] },
      ],
    });
    assert.equal(written.statuses, undefined);
    assert.deepEqual(written.sets, [
      { steps: [{ name: 'STUDY', minutes: 50 }] },
      { name: 'Son', repeat: 3, steps: [{ name: 'STUDY', minutes: 50, kind: 'break', visual: 'v.png', beep: false }] },
    ]);
  });

  it('gidiş-dönüş: yazılan şekil aynı planı ve aynı zaman çizelgesini verir', () => {
    const { plan, again } = roundTrip({
      rounds: 3,
      sets: [
        { name: 'Isınma', repeat: 2, steps: [{ name: 'STUDY', minutes: 25 }, { name: 'MOLA', minutes: 5, beep: false }] },
        { steps: [{ name: 'DEEP WORK', minutes: 90, visual: 'a.mp4' }, { name: 'Yürü', minutes: 20, kind: 'work' }] },
      ],
    });
    assert.deepEqual(again.sets, plan.sets);
    assert.deepEqual(buildTimeline(again), buildTimeline(plan));
  });
});
