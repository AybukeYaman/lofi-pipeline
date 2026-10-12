/**
 * core/pomodoro-plan.js — saf plan/timeline/karşılaştırma mantığı.
 *
 * Senaryolar spec'teki kabul testleriyle aynı sayıları kullanıyor:
 * 50/10×4 ve 30/10×6 → 240 dk, 253:00 fazla, 227:30 eksik.
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
    assert.equal(plan.trimExcess, POMODORO_DEFAULTS.trimExcess);
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

  it('cue dosyaları verilebilir, verilmezse üretilen ses için null kalır', () => {
    const plan = planOf({ cue: { workStartFile: 'C:\\ses\\work_start.wav' } });
    assert.equal(plan.cue.workStartFile, 'C:\\ses\\work_start.wav');
    assert.equal(plan.cue.breakStartFile, null);
    assert.equal(plan.cue.beepFile, null);
  });
});

describe('buildTimeline', () => {
  it('50/10 × 4 → 240 dakika, 8 oturum', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 4 }));
    assert.equal(timeline.totalMinutes, 240);
    assert.equal(timeline.sessions.length, 8);
  });

  it('30/10 × 6 → yine 240 dakika (spec Test 4)', () => {
    const timeline = buildTimeline(planOf({ preset: '30/10', rounds: 6 }));
    assert.equal(timeline.totalMinutes, 240);
    assert.equal(timeline.sessions.length, 12);
  });

  it('oturumlar WORK/BREAK sırasıyla ve boşluksuz dizilir', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 4 }));
    assert.deepEqual(
      timeline.sessions.map((s) => [s.label, s.startSeconds / 60, s.endSeconds / 60]),
      [
        ['WORK 01', 0, 50], ['BREAK 01', 50, 60],
        ['WORK 02', 60, 110], ['BREAK 02', 110, 120],
        ['WORK 03', 120, 170], ['BREAK 03', 170, 180],
        ['WORK 04', 180, 230], ['BREAK 04', 230, 240],
      ],
    );
  });

  it('tur sayısı değişince timeline kendiliğinden yeniden kurulur', () => {
    const timeline = buildTimeline(planOf({ preset: '50/10', rounds: 8 }));
    assert.equal(timeline.totalMinutes, 480);
    assert.equal(timeline.sessions.at(-1).label, 'BREAK 08');
  });

  it('describeTimeline spec\'teki dökümü verir', () => {
    const text = describeTimeline(buildTimeline(planOf({ preset: '50/10', rounds: 4 })));
    assert.ok(text.startsWith('WORK 01\n00:00 - 50:00\n\nBREAK 01\n50:00 - 60:00'));
    assert.ok(text.trimEnd().endsWith('BREAK 04\n230:00 - 240:00'));
  });
});

describe('buildCueEvents', () => {
  const plan = planOf({ preset: '50/10', rounds: 4 });
  const timeline = buildTimeline(plan);

  it('her oturum için T-3/T-2/T-1 beep ve T=0 başlangıç efekti koyar', () => {
    const { events } = buildCueEvents(plan, timeline);
    const atBreak1 = events.filter((e) => e.session === 1);
    assert.deepEqual(
      atBreak1.map((e) => [e.atSeconds, e.type]),
      [[50 * 60 - 3, 'beep'], [50 * 60 - 2, 'beep'], [50 * 60 - 1, 'beep'], [50 * 60, 'start']],
    );
  });

  it('WORK → BREAK ve BREAK → WORK geçişlerinin ikisinde de geri sayım var', () => {
    const { events } = buildCueEvents(plan, timeline);
    const starts = events.filter((e) => e.type === 'start');
    assert.equal(starts.length, 8);
    for (const start of starts.slice(1)) {
      const beeps = events.filter((e) => e.type === 'beep' && e.session === start.session);
      assert.equal(beeps.length, 3, `${start.label} için geri sayım eksik`);
      assert.equal(start.atSeconds - beeps.at(-1).atSeconds, 1);
    }
  });

  it('ilk oturumun geri sayımı videodan önceye düştüğü için atlanır ve raporlanır', () => {
    const { events, skipped } = buildCueEvents(plan, timeline);
    assert.equal(skipped.length, 3);
    assert.ok(skipped.every((s) => s.atSeconds < 0 && s.session === 0));
    // Başlangıç efekti yerinde: video 0. saniyede WORK ile açılıyor.
    assert.ok(events.some((e) => e.atSeconds === 0 && e.type === 'start' && e.kind === 'work'));
  });

  it('olaylar zamana göre sıralı döner', () => {
    const { events } = buildCueEvents(plan, timeline);
    const times = events.map((e) => e.atSeconds);
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
  });

  it('kapatılan ses türü hiç olay üretmez', () => {
    const quiet = planOf({ preset: '50/10', rounds: 2, countdownBeep: false, breakStartSound: false });
    const { events } = buildCueEvents(quiet, buildTimeline(quiet));
    assert.ok(events.every((e) => e.type === 'start'));
    assert.ok(events.every((e) => e.kind === 'work'));
    assert.equal(events.length, 2);
  });
});

describe('compareMusic', () => {
  const plan = planOf({ preset: '50/10', rounds: 4 });
  const timeline = buildTimeline(plan);

  it('Test 1 — müzik timeline\'a eşitse doğrulama geçer', () => {
    const result = compareMusic({ musicSeconds: 240 * 60, timeline });
    assert.equal(result.status, 'exact');
    assert.equal(result.ok, true);
    assert.equal(result.excessSeconds, 0);
    assert.equal(result.shortSeconds, 0);
  });

  it('saniyenin altındaki toplama sapması eşit sayılır', () => {
    assert.equal(compareMusic({ musicSeconds: 240 * 60 + 0.4, timeline }).status, 'exact');
  });

  it('Test 2 — 13 dakika fazla', () => {
    const result = compareMusic({ musicSeconds: 253 * 60, timeline });
    assert.equal(result.status, 'excess');
    assert.equal(result.ok, false);
    assert.equal(result.excessSeconds, 13 * 60);
    assert.ok(describeComparison(result, plan).includes('Fazla: 13:00'));
  });

  it('Test 3 — 12:30 eksik', () => {
    const result = compareMusic({ musicSeconds: 227.5 * 60, timeline });
    assert.equal(result.status, 'short');
    assert.equal(result.ok, false);
    assert.equal(result.shortSeconds, 12.5 * 60);
    const text = describeComparison(result, plan);
    assert.ok(text.includes('Eksik: 12:30'));
    assert.ok(text.includes('Pomodoro timeline: 240:00'));
    assert.ok(text.includes('Müzik toplamı: 227:30'));
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
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(240 * 60) });
    assert.equal(result.ok, true);
    assert.equal(result.comparison.status, 'exact');
    assert.equal(result.trim, null);
    assert.equal(result.timeline.totalMinutes, 240);
  });

  it('Test 2 — fazla müzik onay istemeden geçmez', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(253 * 60) });
    assert.equal(result.ok, false);
    assert.equal(result.needsTrimConfirmation, true);
    assert.ok(result.problems[0].includes('13:00'));
    // Kırpmanın ne yapacağı onay öncesinde de gösterilir.
    assert.equal(result.trim.trimmedSeconds, 13 * 60);
  });

  it('Test 2 — kırpma onaylanınca geçer ve uyarıya düşer', () => {
    const plan = planOf({ preset: '50/10', rounds: 4, trimExcess: true });
    const result = validatePomodoro({ plan, tracks: tracksOf(253 * 60) });
    assert.equal(result.ok, true);
    assert.equal(result.needsTrimConfirmation, false);
    assert.equal(result.trim.usedSeconds, 240 * 60);
    assert.ok(result.warnings.some((w) => w.includes('13:00')));
  });

  it('Test 3 — eksik müzik onayla bile geçmez', () => {
    const plan = planOf({ preset: '50/10', rounds: 4, trimExcess: true });
    const result = validatePomodoro({ plan, tracks: tracksOf(227.5 * 60) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('12:30')));
  });

  it('ölçülemeyen parça montajı durdurur', () => {
    const result = validatePomodoro({
      plan: planOf({ preset: '50/10', rounds: 4 }),
      tracks: [{ path: 'bozuk.m4a', duration: null }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes('ölçülemedi')));
  });

  it('atlanan ilk geri sayım uyarı olarak raporlanır, montajı durdurmaz', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(240 * 60) });
    assert.equal(result.ok, true);
    assert.equal(result.warnings.filter((w) => w.includes('T-')).length, 3);
  });

  it('PomodoroValidationError mesajı sayıları ve sorunları taşır', () => {
    const result = validatePomodoro({ plan: planOf({ preset: '50/10', rounds: 4 }), tracks: tracksOf(227.5 * 60) });
    const error = new PomodoroValidationError(result);
    assert.equal(error.name, 'PomodoroValidationError');
    assert.ok(error.message.includes('Müzik toplamı: 227:30'));
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
    const plan = planOf({ preset: '30/10', rounds: 6, trimExcess: true, cue: { volumeDb: -6 } });
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
