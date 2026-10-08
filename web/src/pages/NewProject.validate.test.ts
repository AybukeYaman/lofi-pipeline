/**
 * Yeni proje formunun ad doğrulaması.
 *
 * Regresyon: form kuralları kendi regex'iyle tekrarlıyordu ve sunucudan
 * sapmıştı — boşluğu yasaklıyor (projenin kendi düzeni
 * "video3-Neo Tokyo Night" reddediliyordu), Windows ayrılmış adlarını
 * (CON, NUL...) ise kaçırıyordu. Kural artık core/project-name.js'te;
 * bu testler formun o kuralla aynı kaldığını kilitler.
 */

import { describe, expect, it } from 'vitest';

import { validateVideoName } from '../../../core/project-name.js';
import { validate } from './NewProject';

const noNames: string[] = [];

describe('validate — sunucuyla aynı adları kabul eder', () => {
  // prep/scaffold.js dokümantasyonu: boşluk ve & serbest (HANDOFF bölüm 9).
  // Bu liste test/unit/scaffold.test.js'teki geçerli adlarla birebir aynı.
  for (const ok of [
    'video3-Neo Tokyo Night',
    'video1- A Quiet Afternoon with a Book & Coffee',
    'Kış (2026)',
    'console',
  ]) {
    it(`geçerli: ${JSON.stringify(ok)}`, () => {
      expect(validate({ name: ok, existingNames: noNames })).toEqual({});
      // Tek kaynak gerçekten tek: sunucu kuralı da aynı cevabı veriyor.
      expect(validateVideoName(ok)).toEqual([]);
    });
  }
});

describe('validate — sunucunun reddettiğini form da reddeder', () => {
  for (const [bad, fragment] of [
    ['', 'boş'],
    ['   ', 'boş'],
    ['video:3', 'geçersiz karakter'],
    ['neden?', 'geçersiz karakter'],
    ['a/b', 'geçersiz karakter'],
    ['a\\b', 'geçersiz karakter'],
    ['CON', 'ayrılmış'],
    ['nul.txt', 'ayrılmış'],
    ['COM1', 'ayrılmış'],
  ] as const) {
    it(`geçersiz: ${JSON.stringify(bad)}`, () => {
      const errors = validate({ name: bad, existingNames: noNames });
      expect(errors.name, `"${bad}" reddedilmeliydi`).toBeTruthy();
      expect(errors.name).toContain(fragment);
    });
  }

  it('ters eğik çizgi yol kaçışı olarak geçmez', () => {
    // Sunucuda bir kez kaçırılmıştı (regexte \\ yerine \| yazılmıştı):
    // "a\b" videolar kökünün dışına yazmaya çalışıyordu.
    expect(validateVideoName('a\\b')).toHaveLength(1);
  });
});

describe('validate — yalnızca formdaki ek kurallar', () => {
  it('80 karakterden uzun ad reddedilir', () => {
    const long = 'v'.repeat(81);
    expect(validateVideoName(long)).toEqual([]); // sunucu sınır koymuyor
    expect(validate({ name: long, existingNames: noNames }).name).toContain('80 karakter');
  });

  it('80 karakter tam sınırda geçer', () => {
    expect(validate({ name: 'v'.repeat(80), existingNames: noNames })).toEqual({});
  });

  it('var olan ad büyük/küçük harf duyarsız yakalanır', () => {
    const errors = validate({ name: 'Video3', existingNames: ['video3'] });
    expect(errors.name).toContain('zaten var');
  });

  it('baştaki/sondaki boşluk kırpıldıktan sonra değerlendirilir', () => {
    expect(validate({ name: '  video3  ', existingNames: noNames })).toEqual({});
    expect(validate({ name: '  video3  ', existingNames: ['video3'] }).name).toContain('zaten var');
  });
});
