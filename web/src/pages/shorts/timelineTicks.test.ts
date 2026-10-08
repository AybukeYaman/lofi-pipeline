import { describe, expect, it } from 'vitest';

import { buildTicks, formatTickLabel, pickTickStep } from './timelineTicks';

describe('formatTickLabel', () => {
  it('dakika:saniye yazar, kesir göstermez', () => {
    expect(formatTickLabel(0)).toBe('00:00');
    expect(formatTickLabel(80.4)).toBe('01:20');
  });

  it('bir saati geçince saat ekler', () => {
    expect(formatTickLabel(3725)).toBe('1:02:05');
  });
});

describe('pickTickStep', () => {
  it('süre uzadıkça adımı açar', () => {
    // 600 px / 72 px = 8 etiket → 8 bölüm.
    expect(pickTickStep(60, 600)).toBe(10);
    expect(pickTickStep(600, 600)).toBe(120);
    expect(pickTickStep(6000, 600)).toBe(900);
  });

  it('dar ekranda daha seyrek etiket seçer', () => {
    const narrow = pickTickStep(600, 200) ?? 0;
    const wide = pickTickStep(600, 900) ?? 0;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('ölçülemeyen genişlikte ve sıfır sürede null döner', () => {
    expect(pickTickStep(0, 600)).toBeNull();
    expect(pickTickStep(600, 0)).toBeNull();
  });
});

describe('buildTicks', () => {
  it('etiketli çizgiler arasına üç kısa çizgi koyar', () => {
    const ticks = buildTicks(60, 600);
    expect(ticks[0]).toMatchObject({ seconds: 0, percent: 0, major: true, label: '00:00' });
    // adım 10 sn → taksimat 2.5 sn
    expect(ticks.slice(1, 4).every((tick) => !tick.major && tick.label === null)).toBe(true);
    expect(ticks[4]).toMatchObject({ seconds: 10, major: true, label: '00:10' });
  });

  it('çizgiler süreyi aşmaz ve son çizgi videonun sonudur', () => {
    const ticks = buildTicks(97.3, 600);
    expect(ticks.every((tick) => tick.seconds <= 97.3)).toBe(true);
    const last = ticks[ticks.length - 1];
    expect(last.seconds).toBeCloseTo(97.3, 3);
    expect(last.percent).toBe(100);
    expect(last.label).toBe('01:37');
  });

  it('süre taksimata tam oturduğunda son çizgiyi iki kez eklemez', () => {
    const ticks = buildTicks(60, 600);
    const atEnd = ticks.filter((tick) => tick.percent === 100);
    expect(atEnd).toHaveLength(1);
  });

  it('ölçüm yoksa boş döner (ilk render)', () => {
    expect(buildTicks(600, 0)).toEqual([]);
    expect(buildTicks(0, 600)).toEqual([]);
  });
});
