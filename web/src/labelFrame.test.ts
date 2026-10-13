import { describe, expect, test } from 'vitest';

import { positionExpressions } from '../../core/label-filter.js';
import { createLabel } from '../../core/label-plan.js';
import {
  aspectRatioOf,
  dragPosition,
  formatCountdown,
  labelTitle,
  labelTopLeft,
  newLabel,
  nextLabelId,
  nudge,
  pointerFraction,
  previewText,
  scaledSize,
  snapPosition,
  sessionAt,
} from './labelFrame';
import type { PomodoroSession, VideoLabel } from './types';

const SESSIONS: PomodoroSession[] = [
  { index: 0, kind: 'status', statusIndex: 0, name: 'STUDY', round: 1, label: 'STUDY 01', startSeconds: 0, endSeconds: 3000, durationSeconds: 3000 },
  { index: 1, kind: 'status', statusIndex: 1, name: 'BREAK', round: 1, label: 'BREAK 01', startSeconds: 3000, endSeconds: 3600, durationSeconds: 600 },
];

const label = (patch: Partial<VideoLabel>): VideoLabel => ({
  id: 'a', kind: 'text', text: 'Merhaba', x: 0.5, y: 0.5, size: 0.05, color: '#ffffff', start: null, end: null,
  ...patch,
});

/** ffmpeg ifadesini aynı değişkenlerle değerlendirir (max/min yeterli). */
function evalFfmpeg(expression: string, vars: Record<string, number>): number {
  const body = expression.replace(/\b(max|min)\(/g, 'Math.$1(');
  return new Function(...Object.keys(vars), `return ${body};`)(...Object.values(vars)) as number;
}

describe('sunucu formülüyle sözleşme (önizleme = render)', () => {
  const frame = { width: 1280, height: 720 };
  const text = { width: 300, height: 40 };
  const cases = [[0.5, 0.5], [0, 0], [1, 1], [0.1, 0.9], [0.93, 0.07], [0.5, 1]];

  test.each(cases)('x=%s y=%s: labelTopLeft == ffmpeg drawtext ifadesi', (x, y) => {
    const server = positionExpressions({ x, y });
    const vars = { w: frame.width, h: frame.height, text_w: text.width, text_h: text.height };
    const mirror = labelTopLeft({ x, y }, text, frame);
    expect(mirror.left).toBeCloseTo(evalFfmpeg(server.x, vars), 6);
    expect(mirror.top).toBeCloseTo(evalFfmpeg(server.y, vars), 6);
  });
});

describe('yeni etiket varsayılanları sunucuyla aynı', () => {
  test.each(['text', 'pomodoro-status', 'pomodoro-countdown'] as const)('%s', (kind) => {
    expect(newLabel(kind, [])).toEqual(createLabel([], { kind, text: 'Yeni etiket' }));
  });

  test('kimlik kullanılmayan ilk sayıdan üretilir', () => {
    expect(nextLabelId([])).toBe('etiket-01');
    expect(nextLabelId([label({ id: 'etiket-01' }), label({ id: 'etiket-03' })])).toBe('etiket-02');
  });
});

describe('konum hesapları', () => {
  test('metin kareden taşmaz: köşeler kıstırılır', () => {
    const frame = { width: 400, height: 200 };
    const text = { width: 100, height: 20 };
    expect(labelTopLeft({ x: 0, y: 0 }, text, frame)).toEqual({ left: 0, top: 0 });
    expect(labelTopLeft({ x: 1, y: 1 }, text, frame)).toEqual({ left: 300, top: 180 });
    expect(labelTopLeft({ x: 0.5, y: 0.5 }, text, frame)).toEqual({ left: 150, top: 90 });
  });

  test('ekran noktası → oran, kare dışı 0–1\'e kıstırılır', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(pointerFraction({ x: 300, y: 150 }, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerFraction({ x: 0, y: 999 }, rect)).toEqual({ x: 0, y: 1 });
    expect(pointerFraction({ x: 1, y: 1 }, { ...rect, width: 0 })).toEqual({ x: 0.5, y: 0.5 });
  });

  test('sürükleme tutulan noktanın uzaklığını korur (etiket zıplamaz)', () => {
    // Etiket (0.3, 0.4), kullanıcı etiketin biraz sağından (0.35, 0.4) tuttu.
    const origin = { x: 0.3, y: 0.4, pointerX: 0.35, pointerY: 0.4 };
    expect(dragPosition(origin, { x: 0.35, y: 0.4 })).toEqual({ x: 0.3, y: 0.4 });
    expect(dragPosition(origin, { x: 0.55, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
    expect(dragPosition(origin, { x: 5, y: -5 })).toEqual({ x: 1, y: 0 });
  });

  test('ince ayar 0–1 içinde kalır ve gürültü biriktirmez', () => {
    expect(nudge({ x: 0.5, y: 0.5 }, 0.01, -0.01)).toEqual({ x: 0.51, y: 0.49 });
    expect(nudge({ x: 0.999, y: 0.001 }, 0.01, -0.01)).toEqual({ x: 1, y: 0 });
    let pos = { x: 0.1, y: 0.1 };
    for (let i = 0; i < 30; i++) pos = nudge(pos, 0.01, 0);
    expect(pos.x).toBe(0.4);
  });

  test('kadraj oranı çözümü', () => {
    expect(aspectRatioOf('16:9')).toBeCloseTo(16 / 9);
    expect(aspectRatioOf('9:16')).toBeCloseTo(9 / 16);
    expect(aspectRatioOf('saçma')).toBeCloseTo(16 / 9);
    expect(aspectRatioOf(undefined)).toBeCloseTo(16 / 9);
  });
});

describe('önizleme metni (yalnızca okur, zamanlamayı sistem belirler)', () => {
  test('serbest metin her zaman kendi metnini gösterir', () => {
    expect(previewText(label({ text: 'Selam' }), [], 0)).toBe('Selam');
    expect(previewText(label({ text: 'Selam' }), SESSIONS, 9999)).toBe('Selam');
  });

  test('STUDY/BREAK oturuma göre; sınırda yeni oturum, dışarıda görünmez', () => {
    const status = label({ kind: 'pomodoro-status', text: '' });
    expect(previewText(status, SESSIONS, 10)).toBe('STUDY');
    expect(previewText(status, SESSIONS, 2999.9)).toBe('STUDY');
    expect(previewText(status, SESSIONS, 3000)).toBe('BREAK');
    expect(previewText(status, SESSIONS, 3600)).toBeNull();
    expect(previewText(status, [], 0)).toBeNull();
  });

  test('geri sayım oturum bitişine göre (ceil), formatlı', () => {
    const countdown = label({ kind: 'pomodoro-countdown', text: '' });
    expect(previewText(countdown, SESSIONS, 0)).toBe('50:00');
    expect(previewText(countdown, SESSIONS, 2940.4)).toBe('01:00');
    expect(previewText(countdown, SESSIONS, 3000)).toBe('10:00');
    expect(formatCountdown(59.2)).toBe('01:00');
    expect(formatCountdown(-5)).toBe('00:00');
  });

  test('sessionAt ve başlıklar', () => {
    expect(sessionAt(SESSIONS, 3000)?.name).toBe('BREAK');
    expect(sessionAt(SESSIONS, -1)).toBeNull();
    expect(labelTitle(label({ text: 'Selam' }))).toBe('Selam');
    expect(labelTitle(label({ text: '' }))).toBe('Boş etiket');
    expect(labelTitle(label({ kind: 'pomodoro-status' }))).toBe('Çalışma / Mola yazısı');
    expect(labelTitle(label({ kind: 'pomodoro-countdown' }))).toBe('Kalan süre sayacı');
  });
});

describe('sürükle-bırak yardımcıları', () => {
  test('yapışma: eşik içinde orta ve kenar çizgilerine oturur, kılavuzu bildirir', () => {
    expect(snapPosition({ x: 0.51, y: 0.49 })).toEqual({ x: 0.5, y: 0.5, guideX: 0.5, guideY: 0.5 });
    expect(snapPosition({ x: 0.11, y: 0.3 })).toEqual({ x: 0.1, y: 0.3, guideX: 0.1, guideY: null });
    expect(snapPosition({ x: 0.89, y: 0.91 })).toEqual({ x: 0.9, y: 0.9, guideX: 0.9, guideY: 0.9 });
  });

  test('yapışma: eşik dışında konum değişmez', () => {
    expect(snapPosition({ x: 0.3, y: 0.7 })).toEqual({ x: 0.3, y: 0.7, guideX: null, guideY: null });
    expect(snapPosition({ x: 0.53, y: 0.5 }, 0.02).guideX).toBeNull();
  });

  test('köşeden boyutlandırma: genişlik oranında büyür/küçülür, sınırlara kıstırılır', () => {
    expect(scaledSize(0.05, 100, 100)).toBe(0.1);
    expect(scaledSize(0.05, 100, -50)).toBe(0.025);
    expect(scaledSize(0.05, 100, 9999)).toBe(0.2);
    expect(scaledSize(0.05, 100, -9999)).toBe(0.02);
    expect(scaledSize(0.05, 0, 40)).toBe(0.05);
  });
});
