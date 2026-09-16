import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPlannerPrompt, cleanIdeaText, planTrackIdeas } from '../../prep/album-planner.js';
import { AlbumPlanError } from '../../prep/album-errors.js';

/** Gemini yanıtını taklit eden sahte fetch; gönderilen gövdeyi kaydeder. */
function fakeGemini(payload, sent = []) {
  return async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    };
  };
}

const ideas = (n) => Array.from({ length: n }, (_, i) => ({ index: i + 1, title: `T${i + 1}`, atmosphere: `mood ${i + 1}` }));

test('planTrackIdeas - eksik/geçersiz parametreler AlbumPlanError fırlatır', async () => {
  await assert.rejects(() => planTrackIdeas({ concept: '', trackCount: 3 }), /Albüm konsepti boş olamaz/);
  await assert.rejects(() => planTrackIdeas({ concept: 'Night', trackCount: 0 }), AlbumPlanError);
  await assert.rejects(() => planTrackIdeas({ concept: 'Night', trackCount: 21 }), AlbumPlanError);
  await assert.rejects(() => planTrackIdeas({ concept: 'Night', trackCount: 2.5 }), AlbumPlanError);
});

test('planTrackIdeas - yalnızca başlık ve atmosfer döner, metinleri temizler', async () => {
  const sent = [];
  const fetchFn = fakeGemini({
    albumTitle: 'Late Night',
    tracks: [
      { index: 1, title: '  "Intro"  [Vocals] ', atmosphere: 'calm   rain', additionalInstruments: ['flute'] },
      { index: 2, title: '', atmosphere: '' },
    ],
  }, sent);

  const result = await planTrackIdeas({ concept: 'Late Night', trackCount: 2 }, { apiKey: 'test-key', fetchFn });

  assert.equal(sent[0].headers['x-goog-api-key'], 'test-key');
  assert.deepEqual(result, {
    albumTitle: 'Late Night',
    tracks: [
      { index: 1, title: 'Intro Vocals', atmosphere: 'calm rain' },
      { index: 2, title: 'Track 2', atmosphere: 'Late Night' },
    ],
  });
});

test('planTrackIdeas - parça sayısı tutmazsa yay kaymasın diye hata verir', async () => {
  await assert.rejects(
    () => planTrackIdeas({ concept: 'Night', trackCount: 3 }, { apiKey: 'k', fetchFn: fakeGemini({ albumTitle: 'x', tracks: ideas(2) }) }),
    /3 yerine 2 parça/,
  );
});

test('planTrackIdeas - bozuk yanıtlar AlbumPlanError olur', async () => {
  await assert.rejects(
    () => planTrackIdeas({ concept: 'Night', trackCount: 1 }, { apiKey: 'k', fetchFn: fakeGemini({ albumTitle: 'x', tracks: [] }) }),
    /tracks listesi bulunamadı/,
  );
});

test('buildPlannerPrompt - yayı album-arc.js tarif eder, ortada trough vardır', () => {
  const prompt = buildPlannerPrompt({ concept: 'Night', trackCount: 5, styleContext: 'lofi hip hop' });

  assert.match(prompt, /Track 1: opening/);
  assert.match(prompt, /Track 3: trough \(very slow tempo, spacious\)/);
  assert.match(prompt, /Track 5: resolution/);
  assert.match(prompt, /- trough \(40-60% of the album\)/);
  assert.match(prompt, /lofi hip hop/);
  // Eski, yanlış yay (ortada zirve) artık yok.
  assert.doesNotMatch(prompt, /peak/i);
});

test('cleanIdeaText - meta etiket karakterlerini ve fazla boşluğu siler', () => {
  assert.equal(cleanIdeaText(' [No Vocals] {x} <y> "z" '), 'No Vocals x y z');
  assert.equal(cleanIdeaText(42), '');
});
