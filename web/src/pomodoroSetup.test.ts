import { describe, expect, it } from 'vitest';

import {
  ROUND_CHOICES,
  durationLabel,
  pomodoroSummary,
  roundChoicesFor,
  roundsKeepingTotal,
  totalMinutes,
} from './pomodoroSetup';

describe('durationLabel', () => {
  it('dakikayı günlük dille yazar', () => {
    expect(durationLabel(40)).toBe('40 dk');
    expect(durationLabel(60)).toBe('1 saat');
    expect(durationLabel(80)).toBe('1 saat 20 dk');
    expect(durationLabel(120)).toBe('2 saat');
    expect(durationLabel(240)).toBe('4 saat');
  });
});

describe('totalMinutes / pomodoroSummary', () => {
  it('50/10 × 2 tur = 2 saat', () => {
    expect(totalMinutes(50, 10, 2)).toBe(120);
    expect(pomodoroSummary(50, 10, 2)).toBe('50/10 · 2 saat · 2 tur');
  });

  it('30/10 × 3 tur de 2 saat eder', () => {
    expect(pomodoroSummary(30, 10, 3)).toBe('30/10 · 2 saat · 3 tur');
  });
});

describe('roundsKeepingTotal', () => {
  it('düzen değişince video süresini korur (2 saat: 50/10 → 30/10 = 3 tur)', () => {
    expect(roundsKeepingTotal(120, 30, 10)).toBe(3);
    expect(roundsKeepingTotal(120, 50, 10)).toBe(2);
  });

  it('tam bölünmüyorsa en yakın tura yuvarlar, en az 1 tur', () => {
    expect(roundsKeepingTotal(60, 30, 10)).toBe(2); // 1,5 → 2
    expect(roundsKeepingTotal(10, 50, 10)).toBe(1);
  });

  it('24 turu aşmaz', () => {
    expect(roundsKeepingTotal(10_000, 1, 1)).toBe(24);
  });
});

describe('roundChoicesFor', () => {
  it('sabit liste; elle yazılmış eski değer de görünür ve sıralı kalır', () => {
    expect(roundChoicesFor(2)).toEqual(ROUND_CHOICES);
    expect(roundChoicesFor(8)).toEqual([1, 2, 3, 4, 6, 8]);
    expect(roundChoicesFor(5)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
