import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ingestSunoUrl, parseSunoUrl, sanitizeFilename } from '../../prep/suno-ingest.js';
import { SunoIngestError } from '../../prep/suno-errors.js';

test('sanitizeFilename - geçersiz karakterleri temizleme', () => {
  assert.equal(sanitizeFilename('Chill / Lofi: Song?'), 'Chill-Lofi-Song');
  assert.equal(sanitizeFilename('   Multiple   Spaces   '), 'Multiple-Spaces');
  assert.equal(sanitizeFilename('***'), 'untitled');
});

test('parseSunoUrl - geçersiz URL durumunda SunoIngestError fırlatılır', async () => {
  await assert.rejects(
    () => parseSunoUrl('https://example.com/not-suno'),
    (err) => err instanceof SunoIngestError && err.message.includes('Desteklenmeyen Suno URL formatı')
  );

  await assert.rejects(
    () => parseSunoUrl(12345),
    (err) => err instanceof SunoIngestError && err.message.includes('Geçerli bir Suno URL dizesi verilmeli')
  );
});

test('parseSunoUrl - sahte Next.js HTML sayfasından song parsing', async () => {
  const fakeSongHtml = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "clip": {
                  "id": "11111111-2222-3333-4444-555555555555",
                  "title": "Midnight Coffee",
                  "audio_url": "https://cdn1.suno.ai/11111111-2222-3333-4444-555555555555.mp3",
                  "metadata": { "duration": 180.5 }
                }
              }
            }
          }
        </script>
      </head>
      <body></body>
    </html>
  `;

  const fakeFetch = async (url) => {
    return {
      ok: true,
      status: 200,
      text: async () => fakeSongHtml,
    };
  };

  const result = await parseSunoUrl('https://suno.com/song/11111111-2222-3333-4444-555555555555', fakeFetch);
  assert.equal(result.isPlaylist, false);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].clipId, '11111111-2222-3333-4444-555555555555');
  assert.equal(result.clips[0].title, 'Midnight Coffee');
  assert.equal(result.clips[0].duration, 180.5);
});

test('ingestSunoUrl - sahte fetch ile MP3 indirme ve dosya yazımı', async () => {
  const outputDir = join(process.cwd(), 'test/tmp-suno-ingest');

  const fakeSongHtml = `
    <html>
      <head>
        <script id="__NEXT_DATA__" type="application/json">
          {
            "props": {
              "pageProps": {
                "clip": {
                  "id": "99999999-8888-7777-6666-555555555555",
                  "title": "Rainy Mood",
                  "audio_url": "https://cdn1.suno.ai/99999999-8888-7777-6666-555555555555.mp3"
                }
              }
            }
          }
        </script>
      </head>
      <body></body>
    </html>
  `;

  const fakeAudioData = new Uint8Array([0x49, 0x44, 0x33]); // MP3 ID3 header mock

  const fakeFetch = async (url) => {
    if (url.includes('suno.com/song/')) {
      return {
        ok: true,
        status: 200,
        text: async () => fakeSongHtml,
      };
    }
    if (url.includes('cdn1.suno.ai')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => fakeAudioData.buffer,
      };
    }
    return { ok: false, status: 404 };
  };

  try {
    const result = await ingestSunoUrl(
      {
        url: 'https://suno.com/song/99999999-8888-7777-6666-555555555555',
        outputDir,
      },
      { fetchFn: fakeFetch }
    );

    assert.equal(result.tracks.length, 1);
    assert.equal(result.tracks[0].title, 'Rainy Mood');
    assert.equal(result.tracks[0].localPath, join(outputDir, '01-Rainy-Mood.mp3'));
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
});
