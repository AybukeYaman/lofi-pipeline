import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
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

test('ingestSunoUrl - sayfa ve indirme isteklerinin hepsi zaman aşımı sinyali taşır', async () => {
  const outputDir = join(process.cwd(), 'test-temp-suno-timeout');
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { clip: { id: '11111111-2222-3333-4444-555555555555', title: 'T', audio_url: 'https://cdn1.suno.ai/t.mp3' } } },
  })}</script>`;
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, signal: options?.signal });
    if (url.includes('cdn1.suno.ai')) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) };
    return { ok: true, status: 200, text: async () => html };
  };

  try {
    await ingestSunoUrl({ url: 'https://suno.com/song/11111111-2222-3333-4444-555555555555', outputDir }, { fetchFn: fakeFetch });
    assert.ok(calls.length >= 2, 'sayfa + en az bir indirme');
    for (const call of calls) assert.ok(call.signal instanceof AbortSignal, call.url);
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('güncel Suno sayfası (RSC) ve uyarılar', () => {
  const ID = '15b3ef3e-a0b3-4ffc-9cf2-e6da4df0b3af';
  const rscPage = (fields) => `<html><head><title>Sabah by kuzru | Suno</title></head><body><script>self.__next_f.push([1,"{\\"id\\":\\"${ID}\\",\\"entity_type\\":\\"song_schema\\",${fields}}"])</script></body></html>`;
  const page = (html, { status = 200, url = `https://suno.com/song/${ID}?sh=KFj9r501wKVxarsv` } = {}) =>
    async () => ({ ok: status < 400, status, url, text: async () => html });

  test('kısa link (/s/<kod>) kabul edilir, yönlendirilen /song/<uuid> üzerinden clip okunur', async () => {
    const fetchFn = page(rscPage(`\\"audio_url\\":\\"https://cdn1.suno.ai/${ID}.mp3\\",\\"title\\":\\"Sabah\\"`));
    const result = await parseSunoUrl('https://suno.com/s/KFj9r501wKVxarsv', fetchFn);
    assert.equal(result.id, ID);
    assert.deepEqual(result.clips, [{ clipId: ID, title: 'Sabah', audioUrl: `https://cdn1.suno.ai/${ID}.mp3` }]);
  });

  test('audio_url "forbidden" ve CDN erişilemezse → SunoIngestError fırlatılır', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push(url);
      if (url.includes('cdn1.suno.ai')) return { ok: false, status: 403 };
      return page(rscPage(`\\"audio_url\\":\\"https://studio-api.prod.suno.com/api/forbidden\\",\\"media_urls\\":[{\\"url\\":\\"https://x.cloudfront.net/1/clip/${ID}.m4a\\"}]`))(url, options);
    };
    await assert.rejects(
      ingestSunoUrl({ url: 'https://suno.com/s/KFj9r501wKVxarsv', outputDir: join(process.cwd(), 'test-temp-suno-forbidden') }, { fetchFn }),
      (err) => err instanceof SunoIngestError,
    );
    assert.ok(calls.length >= 1);
  });

  test('is_public:false olsa bile şarkı ve CDN adresi başarıyla okunur (usesuno davranışı)', async () => {
    const fetchFn = page(rscPage(`\\"is_public\\":false,\\"audio_url\\":\\"https://cdn1.suno.ai/${ID}.mp3\\",\\"title\\":\\"Sabah\\"`));
    const result = await parseSunoUrl(`https://suno.com/song/${ID}`, fetchFn);
    assert.equal(result.id, ID);
    assert.equal(result.clips[0].title, 'Sabah');
    assert.equal(result.clips[0].audioUrl, `https://cdn1.suno.ai/${ID}.mp3`);
  });

  test('HTTP 404/403 veya sayfa verisi olmasa bile tek şarkı URL kimliğinden CDN klibi oluşturulur', async () => {
    const result404 = await parseSunoUrl(`https://suno.com/song/${ID}`, page('', { status: 404 }));
    assert.equal(result404.clips[0].clipId, ID);
    assert.equal(result404.clips[0].audioUrl, `https://cdn1.suno.ai/${ID}.mp3`);

    const result403 = await parseSunoUrl(`https://suno.com/song/${ID}`, page('', { status: 403 }));
    assert.equal(result403.clips[0].clipId, ID);

    const resultLogin = await parseSunoUrl(`https://suno.com/song/${ID}`, page('<html>giriş yap</html>'));
    assert.equal(resultLogin.clips[0].clipId, ID);
  });

  test('Public olmayan playlist için notPublic uyarısı fırlatılır', async () => {
    const playlistId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const fetchFn = page(`<html><head><title>Private Playlist</title></head><body><script>self.__next_f.push([1,"{\\"id\\":\\"${playlistId}\\",\\"is_public\\":false}"])</script></body></html>`, { url: `https://suno.com/playlist/${playlistId}` });
    await assert.rejects(parseSunoUrl(`https://suno.com/playlist/${playlistId}`, fetchFn), (err) => err.notPublic && err.message.includes('public değil'));
  });
});
