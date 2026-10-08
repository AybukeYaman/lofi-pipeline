/**
 * Kütüphane ekranlarının ortak arama süzgeci.
 *
 * Regresyon: süzgeç düz `toLowerCase()` kullanıyordu ve Türkçe "İ" doğru
 * küçülmediği için Ambiance/Mimi sayfalarında "İ" ile başlayan adlar
 * bulunamıyordu; Promptlar sayfası aynı işi kendi içinde doğru yapıyordu.
 */

import { describe, expect, it } from 'vitest';

import { matchesQuery } from './libraryFilter';

describe('matchesQuery', () => {
  it('boş sorgu her şeyi geçirir', () => {
    expect(matchesQuery('', 'herhangi')).toBe(true);
    expect(matchesQuery('   ', 'herhangi')).toBe(true);
  });

  it('büyük/küçük harf duyarsız', () => {
    expect(matchesQuery('RAIN', 'heavyRain.mp3')).toBe(true);
    expect(matchesQuery('rain', 'HeavyRain.mp3')).toBe(true);
  });

  it('Türkçe İ/ı doğru küçülür', () => {
    expect(matchesQuery('istanbul', 'İstanbul gecesi')).toBe(true);
    expect(matchesQuery('İSTANBUL', 'istanbul gecesi')).toBe(true);
    expect(matchesQuery('kis', 'Kış sabahı')).toBe(false);
    expect(matchesQuery('kış', 'Kış sabahı')).toBe(true);
  });

  it('alanlardan herhangi biri tutarsa eşleşir', () => {
    expect(matchesQuery('ambient', 'yagmur.mp3', 'ambient')).toBe(true);
  });

  it('null/undefined alanlar atlanır, patlamaz', () => {
    expect(matchesQuery('not', 'baslik', null, undefined)).toBe(false);
    expect(matchesQuery('not', 'baslik', 'bir not')).toBe(true);
  });

  it('sorgunun baştaki/sondaki boşluğu kırpılır', () => {
    expect(matchesQuery('  rain  ', 'heavyRain.mp3')).toBe(true);
  });

  it('eşleşmeyen sorgu false', () => {
    expect(matchesQuery('kar', 'yagmur.mp3', 'ambient')).toBe(false);
  });
});
