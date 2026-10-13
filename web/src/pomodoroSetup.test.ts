import { describe, expect, it } from 'vitest';

import { POMODORO_PRESETS, buildTimeline, flattenSets, makeSet, makeStep } from '../../core/pomodoro-plan.js';
import {
  INTRO_MINUTES,
  INTRO_TAB,
  MAX_MINUTES,
  STATUS_NAME_MAX,
  addSet,
  addStep,
  bareVisual,
  canAddSet,
  canAddStep,
  canRepeat,
  choiceFromDraft,
  cycleMinutes,
  defaultSets,
  describeProgram,
  durationLabel,
  hasEmptyName,
  matchingProgram,
  moveSet,
  moveStep,
  pomodoroPayload,
  pomodoroSummary,
  programSessions,
  programStats,
  programWarnings,
  readinessPayload,
  removeSet,
  removeStep,
  roundChoicesFor,
  roundsKeepingTotal,
  sameProgram,
  setsFromProgram,
  setsPayload,
  statusTabs,
  studyMinutes,
  totalMinutes,
  totalSteps,
  updateSet,
  updateStep,
  visualOfTab,
  withTabVisual,
  type EditableSet,
} from './pomodoroSetup';
import type { PomodoroProgram, ProjectDetail, ProjectPomodoro } from './types';

const step = makeStep;
/** İki çalışmadan sonra uzun mola: SET 1 = 50+10, SET 2 = 50+20. */
const longBreak = (): EditableSet[] => [
  makeSet('SET 1', 1, [step('STUDY', 50), step('BREAK', 10)]),
  makeSet('SET 2', 1, [step('STUDY', 50), step('LONG BREAK', 20)]),
];
const PROGRAMS: PomodoroProgram[] = POMODORO_PRESETS.map((preset) => ({
  id: preset.id.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name: preset.id,
  builtin: true,
  sets: preset.sets.map((set) => ({ ...set, steps: set.steps.map(({ visual: _visual, ...rest }) => rest) })),
  updatedAt: null,
}));

describe('süre yardımcıları', () => {
  it('durationLabel dakikayı günlük dille yazar', () => {
    expect(durationLabel(40)).toBe('40 dk');
    expect(durationLabel(60)).toBe('1 saat');
    expect(durationLabel(80)).toBe('1 saat 20 dk');
  });

  it('50/10/50/20 × 2 tur: döngü, çalışma ve toplam süre; özet cümlesi', () => {
    const flat = flattenSets(longBreak());
    expect(INTRO_MINUTES).toBe(2);
    expect(cycleMinutes(flat)).toBe(130);
    expect(studyMinutes(flat, 2)).toBe(260);
    expect(totalMinutes(flat, 2)).toBe(262);
    expect(pomodoroSummary(flat, 2)).toBe('50/10/50/20 · 4 saat 22 dk · 2 tur');
  });

  it('roundsKeepingTotal süreyi korur; roundChoicesFor elle yazılmış değeri gösterir', () => {
    expect(roundsKeepingTotal(120, flattenSets(defaultSets()))).toBe(2);
    expect(roundsKeepingTotal(120, flattenSets(longBreak()))).toBe(1);
    expect(roundChoicesFor(5)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(roundChoicesFor(2)).toEqual([1, 2, 3, 4, 6]);
  });
});

describe('set düzenleme', () => {
  it('varsayılan program SET 1 = STUDY 50 + BREAK 10; türler addan', () => {
    expect(defaultSets()).toEqual([
      { name: 'SET 1', repeat: 1, steps: [step('STUDY', 50), step('BREAK', 10)] },
    ]);
    expect(defaultSets()[0].steps.map((s) => s.kind)).toEqual(['work', 'break']);
  });

  it('addSet sonraki adla, son çalışmanın süresiyle tek adımlı set ekler', () => {
    const sets = addSet(defaultSets());
    expect(sets.map((s) => s.name)).toEqual(['SET 1', 'SET 2']);
    expect(sets[1].steps).toEqual([step('STUDY', 50)]);
  });

  it('removeSet varsayılan adları yeniden numaralar, elle yazılanı korur; son set silinmez', () => {
    const sets = [makeSet('SET 1', 1, [step('A', 5)]), makeSet('Sabah', 1, [step('B', 5)]), makeSet('SET 3', 1, [step('C', 5)])];
    expect(removeSet(sets, 0).map((s) => s.name)).toEqual(['Sabah', 'SET 2']);
    const one = defaultSets();
    expect(removeSet(one, 0)).toBe(one);
  });

  it('moveSet sırayı değiştirir, varsayılan adlar yeni sıraya göre', () => {
    const moved = moveSet(longBreak(), 0, 1);
    expect(moved.map((s) => s.name)).toEqual(['SET 1', 'SET 2']);
    expect(moved[0].steps[1].name).toBe('LONG BREAK');
    expect(moveSet(longBreak(), 0, 5).map((s) => s.steps[1].name)).toEqual(['BREAK', 'LONG BREAK']);
  });

  it('updateSet adı kısaltır ve tek satıra indirir; sınırı aşan tekrar yok sayılır', () => {
    let sets = updateSet(defaultSets(), 0, { name: 'Çok\nuzun bir set adı burada yazıyor' });
    expect(sets[0].name.length).toBe(STATUS_NAME_MAX);
    expect(sets[0].name).not.toMatch(/\n/);
    sets = updateSet(sets, 0, { repeat: 3 });
    expect(sets[0].repeat).toBe(3);
    expect(updateSet(sets, 0, { repeat: 11 })[0].repeat).toBe(3);
    expect(updateSet(sets, 0, { repeat: 0 })[0].repeat).toBe(3);
  });

  it('sınırlar: set başına 8 adım, turda 24 adım (tekrarlar dahil), en çok 6 set', () => {
    const eight = [makeSet('SET 1', 1, Array.from({ length: 8 }, () => step('A', 5)))];
    expect(canAddStep(eight, 0)).toBe(false);
    expect(addStep(eight, 0)).toBe(eight);

    const full = [makeSet('SET 1', 10, [step('STUDY', 25), step('BREAK', 5)]), makeSet('SET 2', 1, [step('A', 5), step('B', 5), step('C', 5), step('D', 5)])];
    expect(totalSteps(full)).toBe(24);
    expect(canAddStep(full, 1)).toBe(false);
    expect(canAddSet(full)).toBe(false);
    expect(canRepeat(full, 0, 9)).toBe(true);
    expect(canRepeat(defaultSets(), 0, 10)).toBe(true);
    expect(canRepeat(defaultSets(), 0, 11)).toBe(false);

    const six = Array.from({ length: 6 }, (_, i) => makeSet(`SET ${i + 1}`, 1, [step('A', 5)]));
    expect(canAddSet(six)).toBe(false);
  });
});

describe('adım düzenleme', () => {
  it('addStep kullanılmamış ilk öneriyi 10 dk ekler', () => {
    const sets = addStep(defaultSets(), 0);
    expect(sets[0].steps[2]).toEqual(step('LONG BREAK', 10));
    expect(sets[0].steps[2].kind).toBe('break');
  });

  it('removeStep siler; setin son adımı silinmez', () => {
    expect(removeStep(defaultSets(), 0, 0)[0].steps.map((s) => s.name)).toEqual(['BREAK']);
    const single = [makeSet('SET 1', 1, [step('A', 5)])];
    expect(removeStep(single, 0, 0)).toBe(single);
  });

  it('moveStep aynı set içinde ve setler arasında taşır', () => {
    expect(moveStep(defaultSets(), { set: 0, step: 0 }, { set: 0, step: 1 })[0].steps.map((s) => s.name)).toEqual(['BREAK', 'STUDY']);

    const across = moveStep(longBreak(), { set: 0, step: 1 }, { set: 1, step: 0 });
    expect(across.map((s) => s.steps.map((x) => x.name))).toEqual([['STUDY'], ['BREAK', 'STUDY', 'LONG BREAK']]);

    const lonely = [makeSet('SET 1', 1, [step('A', 5)]), makeSet('SET 2', 1, [step('B', 5)])];
    expect(moveStep(lonely, { set: 0, step: 0 }, { set: 1, step: 0 })).toBe(lonely);
  });

  it('moveStep tur sınırını aşacaksa taşımaz (hedef set çok tekrarlıysa)', () => {
    const sets = [makeSet('SET 1', 1, [step('A', 5), step('B', 5)]), makeSet('SET 2', 10, [step('C', 5), step('D', 5)])];
    expect(totalSteps(sets)).toBe(22);
    expect(moveStep(sets, { set: 0, step: 0 }, { set: 1, step: 0 })).toBe(sets);
  });

  it('updateStep: süre sınıra kıstırılır; ad değişince tahmin edilen tür yeniden tahmin edilir, elle seçilen korunur', () => {
    let sets = updateStep(defaultSets(), 0, 0, { minutes: 999 });
    expect(sets[0].steps[0].minutes).toBe(MAX_MINUTES);
    expect(updateStep(sets, 0, 0, { minutes: 0 })[0].steps[0].minutes).toBe(1);

    sets = updateStep(defaultSets(), 0, 0, { name: 'MOLA' });
    expect(sets[0].steps[0].kind).toBe('break');

    sets = updateStep(defaultSets(), 0, 1, { kind: 'work' });
    sets = updateStep(sets, 0, 1, { name: 'Okuma molası' });
    expect(sets[0].steps[1].kind).toBe('work');
  });

  it('hasEmptyName boş adım ya da set adını bulur', () => {
    expect(hasEmptyName(defaultSets())).toBe(false);
    expect(hasEmptyName(updateStep(defaultSets(), 0, 0, { name: '  ' }))).toBe(true);
    expect(hasEmptyName(updateSet(defaultSets(), 0, { name: '' }))).toBe(true);
  });
});

describe('hazır ve kayıtlı programlar', () => {
  it('sameProgram yapı aynıysa doğru (görüntü karşılaştırılmaz)', () => {
    const withVisual = withTabVisual('STUDY', 'a.png', longBreak(), { visual: null }).sets;
    expect(sameProgram(withVisual, PROGRAMS[2].sets)).toBe(true);
    expect(sameProgram(updateSet(longBreak(), 1, { repeat: 2 }), PROGRAMS[2].sets)).toBe(false);
    expect(sameProgram(updateStep(longBreak(), 0, 1, { beep: false }), PROGRAMS[2].sets)).toBe(false);
  });

  it('matchingProgram uyan hazır programı bulur; bozuk kayıt atlanır', () => {
    expect(matchingProgram(defaultSets(), PROGRAMS)?.name).toBe('50/10');
    expect(matchingProgram(longBreak(), PROGRAMS)?.name).toBe('50/10/50/20');
    expect(matchingProgram(updateStep(longBreak(), 0, 0, { minutes: 45 }), PROGRAMS)).toBeNull();
    const broken = { ...PROGRAMS[0], id: 'bozuk', builtin: false, error: 'JSON' };
    expect(matchingProgram(defaultSets(), [broken])).toBeNull();
  });

  it('setsFromProgram aynı adlı adımın görüntüsünü korur', () => {
    const current = withTabVisual('BREAK', 'mola.png', defaultSets(), { visual: null }).sets;
    const next = setsFromProgram(PROGRAMS[3], current);
    expect(next.map((s) => [s.name, s.repeat])).toEqual([['SET 1', 3], ['SET 2', 1]]);
    expect(next[0].steps.map((s) => s.visual)).toEqual([null, 'mola.png']);
    expect(next[1].steps.map((s) => s.visual)).toEqual([null, null]);
  });
});

describe('önizleme: gerçek zaman çizelgesiyle aynı kaynak', () => {
  it('programSessions core buildTimeline ile birebir aynı', () => {
    const sets = updateSet(longBreak(), 0, { repeat: 2 });
    expect(programSessions(sets, 3)).toEqual(buildTimeline({ sets, rounds: 3, intro: { visual: null } }).sessions);
  });

  it('50/10/50/20 × 2: sıra, sayaçlar ve set bilgisi', () => {
    const sessions = programSessions(longBreak(), 2);
    expect(sessions.map((s) => s.label)).toEqual([
      'GET READY', 'STUDY 01', 'BREAK 01', 'STUDY 02', 'LONG BREAK 01',
      'STUDY 03', 'BREAK 02', 'STUDY 04', 'LONG BREAK 02',
    ]);
    expect(sessions.slice(1).map((s) => s.setIndex)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('programStats: çalışma sayısı ve süreler doğru', () => {
    expect(programStats(longBreak(), 2)).toEqual({
      workCount: 4, breakCount: 4, workMinutes: 200, breakMinutes: 60,
      introMinutes: 2, totalMinutes: 262, stepsPerRound: 4,
    });
  });

  it('bir adım değişince set, loop ve toplam birlikte güncellenir', () => {
    const changed = updateStep(longBreak(), 1, 1, { minutes: 30 });
    expect(programStats(changed, 2).totalMinutes).toBe(282);
    expect(programStats(updateSet(changed, 0, { repeat: 2 }), 2).workCount).toBe(6);
  });

  it('describeProgram düz Türkçe anlatır', () => {
    expect(describeProgram(longBreak(), 2)).toEqual([
      '1. çalışma (50 dk) bitince 10 dk BREAK verilir.',
      '2. çalışma (50 dk) bitince 20 dk LONG BREAK verilir.',
      'Bu set sırası toplam 2 kez uygulanacak.',
      'Program 4 çalışma adımından sonra sona erecek.',
    ]);
    expect(describeProgram([makeSet('SET 1', 1, [step('STUDY', 25), step('READ', 25)])], 1)).toEqual([
      '1. çalışma (25 dk) bitince doğrudan sonraki adıma geçilir.',
      '2. çalışma (25 dk) bitince doğrudan sonraki adıma geçilir.',
      'Bu set sırası bir kez uygulanacak.',
      'Program 2 çalışma adımından sonra sona erecek.',
    ]);
  });

  it('programWarnings: moladan başlama, arka arkaya mola, hiç çalışma yok', () => {
    expect(programWarnings(longBreak())).toEqual([]);
    expect(programWarnings([makeSet('SET 1', 1, [step('BREAK', 5)])])).toHaveLength(2);
    const twice = programWarnings([makeSet('SET 1', 1, [step('STUDY', 5), step('BREAK', 5), step('WALK', 5)])]);
    expect(twice).toHaveLength(1);
    expect(twice[0]).toMatch(/arka arkaya/);
  });
});

describe('Video adımı sekmeleri', () => {
  it('statusTabs aynı adlı adımları tek sekmede toplar', () => {
    expect(statusTabs(flattenSets(longBreak())).map((t) => t.label)).toEqual(['GET READY', 'STUDY', 'BREAK', 'LONG BREAK']);
  });

  it('withTabVisual aynı adlı bütün adımları her sette günceller; visualOfTab okur', () => {
    const { sets, intro } = withTabVisual('STUDY', 'calisma.png', longBreak(), { visual: null });
    expect(flattenSets(sets).map((s) => s.visual)).toEqual(['calisma.png', null, 'calisma.png', null]);
    expect(visualOfTab('STUDY', flattenSets(sets), intro)).toBe('calisma.png');
    const ready = withTabVisual(INTRO_TAB, 'hazir.png', sets, intro);
    expect(ready.intro.visual).toBe('hazir.png');
    expect(ready.sets).toBe(sets);
  });
});

describe('sunucu gövdesi', () => {
  it('setsPayload adları kırpar, türü gönderir, bip/görüntüyü yalnızca gerekirse', () => {
    let sets = updateStep(longBreak(), 0, 0, { name: ' STUDY ' });
    sets = updateStep(sets, 1, 1, { beep: false });
    sets = withTabVisual('BREAK', 'm.png', sets, { visual: null }).sets;
    expect(setsPayload(sets)).toEqual([
      { name: 'SET 1', repeat: 1, steps: [{ name: 'STUDY', minutes: 50, kind: 'work' }, { name: 'BREAK', minutes: 10, kind: 'break', visual: 'm.png' }] },
      { name: 'SET 2', repeat: 1, steps: [{ name: 'STUDY', minutes: 50, kind: 'work' }, { name: 'LONG BREAK', minutes: 20, kind: 'break', beep: false }] },
    ]);
  });

  it('readinessPayload proje durumundan tam gövde kurar', () => {
    const readiness = {
      enabled: true, rounds: 2, sets: longBreak(), statuses: flattenSets(longBreak()),
      intro: { visual: './hazir.png' }, countdownBeep: true,
    } as NonNullable<ProjectDetail['readiness']['pomodoro']>;
    const body = readinessPayload(readiness, { rounds: 3 });
    expect(body.rounds).toBe(3);
    expect(body.intro).toEqual({ visual: './hazir.png' });
    expect(body.sets?.map((s) => s.steps.length)).toEqual([2, 2]);
  });

  it('pomodoroPayload ayar yoksa varsayılanları gönderir', () => {
    const data = {
      settings: null,
      defaults: { enabled: false, rounds: 4, sets: defaultSets(), statuses: flattenSets(defaultSets()), countdownSeconds: 3, countdownBeep: true },
    } as unknown as ProjectPomodoro;
    expect(pomodoroPayload(data)).toEqual({
      enabled: true,
      rounds: 4,
      sets: [{ name: 'SET 1', repeat: 1, steps: [{ name: 'STUDY', minutes: 50, kind: 'work' }, { name: 'BREAK', minutes: 10, kind: 'break' }] }],
      countdownBeep: true,
    });
  });

  it('bareVisual baştaki ./ işaretini atar', () => {
    expect(bareVisual('./resimler/a.png')).toBe('resimler/a.png');
    expect(bareVisual('resimler/a.png')).toBe('resimler/a.png');
  });
});

describe('choiceFromDraft', () => {
  it('yeni taslak setleriyle geri gelir', () => {
    const restored = choiceFromDraft({ sets: longBreak(), rounds: 3 });
    expect(restored?.rounds).toBe(3);
    expect(restored?.sets.map((s) => s.steps.map((x) => x.name))).toEqual([['STUDY', 'BREAK'], ['STUDY', 'LONG BREAK']]);
  });

  it('eski taslağın düz listesi tek set olur; tür addan, bip korunur', () => {
    const restored = choiceFromDraft({ statuses: [{ name: 'STUDY', minutes: 25 }, { name: 'MOLA', minutes: 5, beep: false }], rounds: 4 });
    expect(restored?.sets).toHaveLength(1);
    expect(restored?.sets[0].name).toBe('SET 1');
    expect(restored?.sets[0].steps.map((s) => [s.kind, s.beep])).toEqual([['work', true], ['break', false]]);
  });

  it('bozuk taslak atılır', () => {
    expect(choiceFromDraft(null)).toBeNull();
    expect(choiceFromDraft({ workMinutes: 50 })).toBeNull();
    expect(choiceFromDraft({ sets: [{ steps: [{ name: 'A' }] }] })).toBeNull();
    expect(choiceFromDraft({ statuses: [] })).toBeNull();
  });
});
