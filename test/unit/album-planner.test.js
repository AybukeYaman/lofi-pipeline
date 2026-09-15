import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planAlbum } from '../../prep/album-planner.js';
import { AlbumPlanError } from '../../prep/album-errors.js';

test('planAlbum - eksik/geçersiz parametreler AlbumPlanError fırlatır', async () => {
  await assert.rejects(
    () => planAlbum({ concept: '', styleName: 'anime-cel' }),
    (err) => err instanceof AlbumPlanError && err.message.includes('Albüm konsepti boş olamaz')
  );

  await assert.rejects(
    () => planAlbum({ concept: 'Night Walk', styleName: '' }),
    (err) => err instanceof AlbumPlanError && err.message.includes('Stil adı belirtilmeli')
  );

  await assert.rejects(
    () => planAlbum({ concept: 'Night Walk', styleName: 'anime-cel', trackCount: 0 }),
    (err) => err instanceof AlbumPlanError && err.message.includes('Parça sayısı 1 ile 20 arasında olmalı')
  );

  await assert.rejects(
    () => planAlbum({ concept: 'Night Walk', styleName: 'olmayan-stil' }),
    (err) => err instanceof AlbumPlanError && err.message.includes('Stil okunamadı')
  );
});

test('planAlbum - sahte fetchFn ile başarılı albüm planlaması ve 11a entegrasyonu', async () => {
  const fakeGeminiResponse = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                albumTitle: 'Late Night Studying',
                tracks: [
                  {
                    index: 1,
                    title: 'Intro Reflection',
                    atmosphere: 'Calm opening with soft rain',
                    additionalMoods: ['peaceful'],
                    additionalInstruments: ['soft flute'],
                  },
                  {
                    index: 2,
                    title: 'Midnight Coffee',
                    atmosphere: 'Warm and cozy focus',
                    additionalMoods: ['cozy'],
                  },
                ],
              }),
            },
          ],
        },
      },
    ],
  };

  const fakeFetch = async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'test-key');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(fakeGeminiResponse),
    };
  };

  const result = await planAlbum(
    { concept: 'Late Night Studying', styleName: 'anime-cel', trackCount: 2 },
    { apiKey: 'test-key', fetchFn: fakeFetch }
  );

  assert.equal(result.concept, 'Late Night Studying');
  assert.equal(result.styleName, 'anime-cel');
  assert.equal(result.albumTitle, 'Late Night Studying');
  assert.equal(result.tracks.length, 2);

  // Track 1 kontrolleri
  assert.equal(result.tracks[0].index, 1);
  assert.equal(result.tracks[0].title, 'Intro Reflection');
  assert.ok(result.tracks[0].stylePrompt.includes('soft flute'));
  assert.ok(result.tracks[0].stylePrompt.includes('peaceful'));

  // Track 2 kontrolleri
  assert.equal(result.tracks[1].index, 2);
  assert.equal(result.tracks[1].title, 'Midnight Coffee');
  assert.ok(result.tracks[1].stylePrompt.includes('cozy'));
});
