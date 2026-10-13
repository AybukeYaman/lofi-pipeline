import { describe, expect, it } from 'vitest';

import {
  INTRO_MINUTES,
  INTRO_TAB,
  MAX_MINUTES,
  MAX_STATUSES,
  ROUND_CHOICES,
  STATUS_NAME_MAX,
  addStatus,
  bareVisual,
  cycleMinutes,
  durationLabel,
  hasEmptyName,
  matchingSet,
  moveStatus,
  pomodoroPayload,
  pomodoroSummary,
  readinessPayload,
  removeStatus,
  roundChoicesFor,
  roundsKeepingTotal,
  statusTabs,
  statusesFromSet,
  statusesPayload,
  studyMinutes,
  totalMinutes,
  updateStatus,
  visualOfTab,
  withTabVisual,
  type EditableStatus,
} from './pomodoroSetup';
import type { PomodoroSet, ProjectPomodoro } from './types';

const status = (name: string, minutes: number, extra: Partial<EditableStatus> = {}): EditableStatus => (
  { name, minutes, beep: true, visual: null, ...extra }
);
const CLASSIC = [status('STUDY', 50), status('BREAK', 10)];
const STRETCH = [status('STUDY', 25), status('STRETCH', 5), status('BREAK', 10)];

describe('durationLabel', () => {
  it('dakikayı günlük dille yazar', () => {
    expect(durationLabel(40)).toBe('40 dk');
    expect(durationLabel(60)).toBe('1 saat');
    expect(durationLabel(80)).toBe('1 saat 20 dk');
    expect(durationLabel(120)).toBe('2 saat');
    expect(durationLabel(240)).toBe('4 saat');
  });
});

describe('cycleMinutes / studyMinutes / totalMinutes / pomodoroSummary', () => {
  it('50/10 × 2 tur = 2 saat çalışma + 2 dk GET READY', () => {
    expect(INTRO_MINUTES).toBe(2);
    expect(cycleMinutes(CLASSIC)).toBe(60);
    expect(studyMinutes(CLASSIC, 2)).toBe(120);
    expect(totalMinutes(CLASSIC, 2)).toBe(122);
    expect(pomodoroSummary(CLASSIC, 2)).toBe('50/10 · 2 saat 2 dk · 2 tur');
  });

  it('üç durumlu döngü de aynı hesapla: 25/5/10 × 3 tur', () => {
    expect(cycleMinutes(STRETCH)).toBe(40);
    expect(totalMinutes(STRETCH, 3)).toBe(122);
    expect(pomodoroSummary(STRETCH, 3)).toBe('25/5/10 · 2 saat 2 dk · 3 tur');
  });
});

describe('roundsKeepingTotal', () => {
  it('liste değişince çalışma süresini korur (2 saat: 50/10 → 30/10 = 3 tur)', () => {
    expect(roundsKeepingTotal(120, [status('A', 30), status('B', 10)])).toBe(3);
    expect(roundsKeepingTotal(120, CLASSIC)).toBe(2);
  });

  it('tam bölünmüyorsa en yakın tura yuvarlar, en az 1 tur', () => {
    expect(roundsKeepingTotal(60, [status('A', 30), status('B', 10)])).toBe(2);
    expect(roundsKeepingTotal(10, CLASSIC)).toBe(1);
  });

  it('24 turu aşmaz', () => {
    expect(roundsKeepingTotal(10_000, [status('A', 1)])).toBe(24);
  });
});

describe('roundChoicesFor', () => {
  it('sabit liste; elle yazılmış eski değer de görünür ve sıralı kalır', () => {
    expect(roundChoicesFor(2)).toEqual(ROUND_CHOICES);
    expect(roundChoicesFor(8)).toEqual([1, 2, 3, 4, 6, 8]);
    expect(roundChoicesFor(5)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('liste düzenleme', () => {
  it('addStatus kullanılmamış ilk öneri adıyla, 10 dk, bip açık ekler; sınırı aşmaz', () => {
    const one = addStatus(CLASSIC);
    expect(one).toHaveLength(3);
    expect(one[2]).toEqual({ name: 'STRETCH', minutes: 10, beep: true, visual: null });
    expect(addStatus(one)[3].name).toBe('LONG BREAK');

    let full = CLASSIC;
    for (let i = 0; i < MAX_STATUSES + 3; i++) full = addStatus(full);
    expect(full).toHaveLength(MAX_STATUSES);
  });

  it('addStatus ad karşılaştırmasında büyük/küçük harfe bakmaz', () => {
    const list = [status('stretch', 5), status('STUDY', 25)];
    expect(addStatus(list)[2].name).toBe('LONG BREAK');
  });

  it('removeStatus en az bir durum bırakır', () => {
    expect(removeStatus(STRETCH, 1).map((s) => s.name)).toEqual(['STUDY', 'BREAK']);
    expect(removeStatus([status('A', 5)], 0)).toHaveLength(1);
  });

  it('moveStatus satırı taşır; geçersiz sırada listeyi değiştirmez', () => {
    expect(moveStatus(STRETCH, 2, 0).map((s) => s.name)).toEqual(['BREAK', 'STUDY', 'STRETCH']);
    expect(moveStatus(STRETCH, 0, 1).map((s) => s.name)).toEqual(['STRETCH', 'STUDY', 'BREAK']);
    expect(moveStatus(STRETCH, 1, 1)).toBe(STRETCH);
    expect(moveStatus(STRETCH, 0, 3)).toBe(STRETCH);
    expect(moveStatus(STRETCH, -1, 1)).toBe(STRETCH);
  });

  it('updateStatus süreyi sınırlara kıstırır, adı kısaltır ve tek satıra çevirir', () => {
    expect(updateStatus(CLASSIC, 0, { minutes: 0 })[0].minutes).toBe(1);
    expect(updateStatus(CLASSIC, 0, { minutes: 9999 })[0].minutes).toBe(MAX_MINUTES);
    expect(updateStatus(CLASSIC, 0, { minutes: 12.6 })[0].minutes).toBe(13);
    expect(updateStatus(CLASSIC, 0, { minutes: Number.NaN })[0].minutes).toBe(50);
    expect(updateStatus(CLASSIC, 1, { name: 'x'.repeat(40) })[1].name).toHaveLength(STATUS_NAME_MAX);
    expect(updateStatus(CLASSIC, 0, { name: 'A\nB' })[0].name).toBe('A B');
    expect(updateStatus(CLASSIC, 0, { beep: false })[0].beep).toBe(false);
    // Diğer satırlar aynı nesne kalır
    expect(updateStatus(CLASSIC, 0, { beep: false })[1]).toBe(CLASSIC[1]);
  });

  it('hasEmptyName boş ya da yalnızca boşluk olan adı yakalar', () => {
    expect(hasEmptyName(CLASSIC)).toBe(false);
    expect(hasEmptyName([status('  ', 5)])).toBe(true);
  });
});

describe('kayıtlı setler', () => {
  const set = (id: string, statuses: PomodoroSet['statuses'], extra: Partial<PomodoroSet> = {}): PomodoroSet => (
    { id, name: id, builtin: false, statuses, updatedAt: null, ...extra }
  );
  const classic = set('50-10', [
    { name: 'STUDY', minutes: 50, beep: true }, { name: 'BREAK', minutes: 10, beep: true },
  ], { builtin: true });

  it('matchingSet ad, süre ve bip birebir uyunca bulur; görüntü karşılaştırılmaz', () => {
    expect(matchingSet(CLASSIC, [classic])?.id).toBe('50-10');
    expect(matchingSet([status('STUDY', 50, { visual: 'resimler/a.png' }), status('BREAK', 10)], [classic])?.id).toBe('50-10');
    expect(matchingSet([status('STUDY', 50), status('BREAK', 10, { beep: false })], [classic])).toBeNull();
    expect(matchingSet([status('STUDY', 50), status('REST', 10)], [classic])).toBeNull();
    expect(matchingSet(STRETCH, [classic])).toBeNull();
  });

  it('bozuk set eşleşmez', () => {
    expect(matchingSet(CLASSIC, [{ ...classic, error: 'bozuk' }])).toBeNull();
  });

  it('statusesFromSet görüntüleri korur: aynı adlı durumun görüntüsü yeni listede de kalır', () => {
    const current = [status('STUDY', 50, { visual: './resimler/calis.png' }), status('BREAK', 10, { visual: './resimler/mola.png' })];
    const next = statusesFromSet(
      set('x', [
        { name: 'BREAK', minutes: 5, beep: false },
        { name: 'STUDY', minutes: 25, beep: true },
        { name: 'WALK', minutes: 5, beep: true },
      ]),
      current,
    );
    expect(next.map((s) => [s.name, s.visual])).toEqual([
      ['BREAK', './resimler/mola.png'],
      ['STUDY', './resimler/calis.png'],
      ['WALK', null],
    ]);
    expect(next[0]).toMatchObject({ minutes: 5, beep: false });
  });
});

describe('Video adımı sekmeleri', () => {
  it('GET READY + her farklı durum adı; aynı adlılar tek sekme', () => {
    const list = [status('STUDY', 25), status('BREAK', 5), status('STUDY', 25), status('BREAK', 5)];
    expect(statusTabs(list)).toEqual([
      { key: INTRO_TAB, label: 'GET READY' },
      { key: 'STUDY', label: 'STUDY' },
      { key: 'BREAK', label: 'BREAK' },
    ]);
  });

  it('visualOfTab sekmenin kayıtlı görüntüsünü verir, yoksa null', () => {
    const list = [status('STUDY', 25), status('BREAK', 5, { visual: './resimler/mola.png' })];
    expect(visualOfTab('BREAK', list, { visual: null })).toBe('./resimler/mola.png');
    expect(visualOfTab('STUDY', list, { visual: null })).toBeNull();
    expect(visualOfTab(INTRO_TAB, list, { visual: './resimler/hazir.png' })).toBe('./resimler/hazir.png');
    expect(visualOfTab('YOK', list, { visual: null })).toBeNull();
  });

  it('withTabVisual aynı adlı BÜTÜN durumları günceller, GET READY ayrı alana yazar', () => {
    const list = [status('STUDY', 25), status('BREAK', 5), status('STUDY', 25), status('BREAK', 5)];
    const study = withTabVisual('STUDY', 'resimler/a.png', list, { visual: null });
    expect(study.statuses.map((s) => s.visual)).toEqual(['resimler/a.png', null, 'resimler/a.png', null]);
    expect(study.intro.visual).toBeNull();

    const intro = withTabVisual(INTRO_TAB, 'resimler/h.png', list, { visual: null });
    expect(intro.intro.visual).toBe('resimler/h.png');
    expect(intro.statuses).toBe(list);

    expect(withTabVisual('STUDY', null, study.statuses, study.intro).statuses.every((s) => s.visual === null)).toBe(true);
  });

  it('bareVisual ./ önekini atar', () => {
    expect(bareVisual('./resimler/a.png')).toBe('resimler/a.png');
    expect(bareVisual('resimler/a.png')).toBe('resimler/a.png');
  });
});

describe('sunucuya giden gövde', () => {
  it('statusesPayload: bip açıksa ve görüntü yoksa o alanlar gönderilmez, ad kırpılır', () => {
    expect(statusesPayload([
      status(' STUDY ', 50),
      status('BREAK', 10, { beep: false, visual: './resimler/mola.png' }),
    ])).toEqual([
      { name: 'STUDY', minutes: 50 },
      { name: 'BREAK', minutes: 10, beep: false, visual: './resimler/mola.png' },
    ]);
  });

  const data = {
    defaults: { enabled: false, rounds: 4, statuses: CLASSIC, countdownSeconds: 3, countdownBeep: true },
    settings: {
      statuses: [status('STUDY', 25), status('STRETCH', 5, { visual: './resimler/e.png' })],
      intro: { visual: './resimler/h.png' },
      rounds: 2,
      preset: null,
      countdownSeconds: 3,
      countdownBeep: false,
      cue: { volumeDb: -10, beepFile: null },
    },
  } as unknown as ProjectPomodoro;

  it('pomodoroPayload ayardaki her şeyi taşır; değişiklik üstüne biner', () => {
    expect(pomodoroPayload(data)).toEqual({
      enabled: true,
      rounds: 2,
      statuses: [{ name: 'STUDY', minutes: 25 }, { name: 'STRETCH', minutes: 5, visual: './resimler/e.png' }],
      intro: { visual: './resimler/h.png' },
      countdownBeep: false,
    });
    expect(pomodoroPayload(data, { rounds: 3 }).rounds).toBe(3);
  });

  it('ayar yoksa varsayılanlardan kurulur', () => {
    const payload = pomodoroPayload({ ...data, settings: null });
    expect(payload.rounds).toBe(4);
    expect(payload.statuses).toEqual([{ name: 'STUDY', minutes: 50 }, { name: 'BREAK', minutes: 10 }]);
    expect('intro' in payload).toBe(false);
  });

  it('readinessPayload proje durumundan aynı gövdeyi kurar (ağır ölçüm ucunu çağırmadan)', () => {
    const payload = readinessPayload({
      enabled: true,
      statuses: [status('STUDY', 25), status('BREAK', 5, { beep: false })],
      intro: { visual: null },
      rounds: 3,
      countdownBeep: true,
    });
    expect(payload).toEqual({
      enabled: true,
      rounds: 3,
      statuses: [{ name: 'STUDY', minutes: 25 }, { name: 'BREAK', minutes: 5, beep: false }],
      countdownBeep: true,
    });
    expect(readinessPayload({ enabled: true, statuses: [status('A', 5)], rounds: 1 }, { intro: {} }).intro).toEqual({});
  });
});
