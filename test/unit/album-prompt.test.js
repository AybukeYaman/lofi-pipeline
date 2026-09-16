import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AlbumPlanError, AlbumPromptError } from '../../prep/album-errors.js';
import {
  SUNO_LIMITS,
  assertSunoLimits,
  buildAlbumDna,
  buildNegativeTags,
  buildTrackStyle,
} from '../../prep/album-prompt.js';

const STYLE = {
  name: 'night-lofi',
  music: {
    genre: 'lofi hip hop',
    production: ['warm tape saturation', 'vinyl crackle'],
    instruments: ['Rhodes piano', 'upright bass'],
    aesthetic: 'late night city, nostalgic',
    exclude: ['vocals', 'EDM drops', 'Vocals'],
  },
};

const MODS = { rhythm: 'gentle understated rhythm, brushed drums', tempo: 'slow tempo', density: 'restrained' };

test('buildAlbumDna - sıra: tür, prodüksiyon, enstrümanlar, estetik', () => {
  assert.equal(
    buildAlbumDna(STYLE),
    'lofi hip hop, warm tape saturation, vinyl crackle, Rhodes piano, upright bass, late night city, nostalgic',
  );
});

test('buildAlbumDna - deterministik: her çağrıda birebir aynı', () => {
  assert.equal(buildAlbumDna(STYLE), buildAlbumDna(structuredClone(STYLE)));
});

test('buildAlbumDna - music bloğu yoksa ya da boşsa AlbumPromptError', () => {
  assert.throws(() => buildAlbumDna({ name: 'anime-cel' }), (err) => err instanceof AlbumPromptError && /music/.test(err.message) && /anime-cel/.test(err.message));
  assert.throws(() => buildAlbumDna({ music: ['x'] }), AlbumPromptError);
  assert.throws(() => buildAlbumDna({ music: { genre: '  ', exclude: ['vocals'] } }), /DNA alanlarının hepsi boş/);
  // AlbumPlanError alt sınıfı — mevcut yakalayıcılar kırılmaz.
  assert.throws(() => buildAlbumDna(null), AlbumPlanError);
});

test('buildTrackStyle - kesin biçim: instrumental kilidi iki uçta, DNA önde', () => {
  assert.equal(
    buildTrackStyle({ dna: 'lofi hip hop, Rhodes piano', atmosphere: 'empty street, rain', energyMods: MODS }),
    '[Instrumental] lofi hip hop, Rhodes piano, empty street, rain, gentle understated rhythm, brushed drums, ' +
    'slow tempo, restrained. No vocals, no lyrics. [No Vocals]',
  );
});

test('buildTrackStyle - farklı atmosferlerde DNA öneki birebir aynı kalır', () => {
  const dna = buildAlbumDna(STYLE);
  const a = buildTrackStyle({ dna, atmosphere: 'first light', energyMods: MODS });
  const b = buildTrackStyle({ dna, atmosphere: 'deep stillness', energyMods: MODS });
  const prefix = `[Instrumental] ${dna}, `;
  assert.ok(a.startsWith(prefix));
  assert.ok(b.startsWith(prefix));
  assert.notEqual(a, b);
});

test('buildTrackStyle - eksik alanlar AlbumPromptError', () => {
  assert.throws(() => buildTrackStyle({ dna: 'x', atmosphere: '', energyMods: MODS }), /atmosphere/);
  assert.throws(() => buildTrackStyle({ dna: 'x', atmosphere: 'y' }), /rhythm, tempo, density/);
  assert.throws(() => buildTrackStyle(), /dna/);
});

test('buildNegativeTags - exclude listesinden, tekrarsız', () => {
  assert.equal(buildNegativeTags(STYLE), 'vocals, EDM drops');
  assert.equal(buildNegativeTags({ music: { genre: 'lofi' } }), '');
});

test('buildNegativeTags - 200 karakter sınırı aşılırsa hata', () => {
  const exclude = Array.from({ length: 30 }, (_, i) => `unwanted tag ${i}`);
  assert.throws(
    () => buildNegativeTags({ music: { genre: 'lofi', exclude } }),
    (err) => err instanceof AlbumPromptError && err.field === 'negativeTags' && err.limit === 200 && err.length > 200,
  );
});

test('assertSunoLimits - sınırların tam üstü ve altı', () => {
  const ok = { style: 's'.repeat(SUNO_LIMITS.style), negativeTags: 'n'.repeat(200), title: 't'.repeat(80) };
  assert.doesNotThrow(() => assertSunoLimits(ok));

  assert.throws(() => assertSunoLimits({ ...ok, style: 's'.repeat(1001) }), (e) => e.field === 'style' && e.length === 1001);
  assert.throws(() => assertSunoLimits({ ...ok, negativeTags: 'n'.repeat(201) }), (e) => e.field === 'negativeTags');
  assert.throws(() => assertSunoLimits({ ...ok, title: 't'.repeat(81) }), (e) => e.field === 'title' && e.limit === 80);
  assert.throws(() => assertSunoLimits({ ...ok, title: undefined }), (e) => e.field === 'title');
});
