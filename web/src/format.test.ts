/**
 * Ortak biçimlendiriciler — ekranlardan toplanan kopyaların yerine geçti.
 */

import { describe, expect, it } from 'vitest';

import { errorText, formatDateTime, formatSize } from './format';

describe('errorText', () => {
  it('Error mesajını verir', () => {
    expect(errorText(new Error('bozuldu'), 'yedek')).toBe('bozuldu');
  });

  it('mesajsız Error ve Error olmayanlar yedeğe düşer', () => {
    expect(errorText(new Error(''), 'yedek')).toBe('yedek');
    expect(errorText('metin', 'yedek')).toBe('yedek');
    expect(errorText(null, 'yedek')).toBe('yedek');
    expect(errorText(undefined, 'yedek')).toBe('yedek');
  });
});

describe('formatSize', () => {
  it('KB basamağı — sıfır bayt bile 1 KB gösterir', () => {
    expect(formatSize(0)).toBe('1 KB');
    expect(formatSize(2048)).toBe('2 KB');
  });

  it('MB basamağı', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  // Shorts ekranının eski kopyasında GB basamağı yoktu: 2 GB'lık çıktı
  // "2048.0 MB" diye görünüyordu.
  it('GB basamağı', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  });

  // Mimi'nin eski kopyası null bilmiyordu, Shorts'un kopyası biliyordu.
  it('null geçirilirse null döner', () => {
    expect(formatSize(null)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('tr-TR gün.ay.yıl saat:dakika', () => {
    const formatted = formatDateTime(new Date(2026, 9, 7, 14, 5).getTime());
    expect(formatted).toContain('07.10.2026');
    expect(formatted).toContain('14:05');
  });
});
