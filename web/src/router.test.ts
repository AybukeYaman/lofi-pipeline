/**
 * Rota çözümü — özellikle "yeni proje" rotasının üst proje taşıması.
 *
 * Regresyon: `?parent=` bilgisi eskiden NewProject içinde
 * `window.location.search` okunarak alınıyordu; rotaya taşınınca
 * `parseRoute` yalnızca `pathname` ile çağrıldığı için sorgu dizesi
 * düşüyordu (sayfa yenilenince üst proje seçimi kayboluyordu).
 */

import { describe, expect, it } from 'vitest';

import { newProjectPath, parseRoute, projectPath } from './router';

describe('parseRoute', () => {
  it('bilinmeyen yol dashboard', () => {
    expect(parseRoute('/')).toEqual({ name: 'dashboard' });
    expect(parseRoute('/bilinmeyen')).toEqual({ name: 'dashboard' });
  });

  it('sabit sayfalar', () => {
    expect(parseRoute('/ambient')).toEqual({ name: 'ambient' });
    expect(parseRoute('/mimi')).toEqual({ name: 'mimi' });
    expect(parseRoute('/prompts')).toEqual({ name: 'prompts' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
  });

  it('proje kimliği yol kodlamasından çözülür', () => {
    expect(parseRoute('/projects/video3-Neo%20Tokyo%20Night')).toEqual({
      name: 'project',
      id: 'video3-Neo Tokyo Night',
    });
  });

  it('yeni proje üst proje olmadan', () => {
    expect(parseRoute('/new')).toEqual({ name: 'newProject', parentId: undefined });
  });

  it('yeni proje ?parent= ile — boşluklu ad dahil', () => {
    expect(parseRoute('/new?parent=video3-Neo%20Tokyo%20Night')).toEqual({
      name: 'newProject',
      parentId: 'video3-Neo Tokyo Night',
    });
  });

  it('boş ?parent= üst proje saymaz', () => {
    expect(parseRoute('/new?parent=')).toEqual({ name: 'newProject', parentId: undefined });
  });

  it('sorgu dizesi başka sayfaların çözümünü bozmaz', () => {
    expect(parseRoute('/settings?x=1')).toEqual({ name: 'settings' });
  });
});

describe('URL kurucular', () => {
  it('projectPath kimliği kodlar', () => {
    expect(projectPath('Kış (2026)')).toBe('/projects/K%C4%B1%C5%9F%20(2026)');
  });

  it('newProjectPath üst projesiz sade yol verir', () => {
    expect(newProjectPath()).toBe('/new');
    expect(newProjectPath(undefined)).toBe('/new');
  });

  it('newProjectPath ↔ parseRoute gidiş-dönüş', () => {
    for (const parentId of ['video3', 'video3-Neo Tokyo Night', 'Kış (2026)', 'a&b']) {
      expect(parseRoute(newProjectPath(parentId))).toEqual({ name: 'newProject', parentId });
    }
  });
});
