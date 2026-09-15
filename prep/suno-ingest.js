/**
 * Suno Ingest Adapter (11c).
 * Public Suno playlist veya song linkinden clip verilerini ve metadata'ları çıkarır,
 * MP3 dosyalarını indirip hedef klasöre yerleştirir.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SunoIngestError } from './suno-errors.js';

const SUNO_URL_REGEX = /^https?:\/\/(?:www\.)?suno\.com\/(playlist|song|s)\/([a-f0-9-]+)/i;

/**
 * Dosya adlarında kullanılamayacak geçersiz karakterleri temizler.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeFilename(text) {
  if (!text) return 'untitled';
  return text
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'untitled';
}

/**
 * Suno URL'sinden clip ID ve metadata bilgilerini çıkarır.
 *
 * @param {string} url
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{ isPlaylist: boolean, id: string, clips: Array<{ clipId: string, title: string, audioUrl: string, duration?: number }> }>}
 */
export async function parseSunoUrl(url, fetchFn = fetch) {
  if (typeof url !== 'string') {
    throw new SunoIngestError('Geçerli bir Suno URL dizesi verilmeli.');
  }

  const match = url.trim().match(SUNO_URL_REGEX);
  if (!match) {
    throw new SunoIngestError(`Desteklenmeyen Suno URL formatı: "${url}". Format "https://suno.com/playlist/<id>" veya "https://suno.com/song/<id>" olmalı.`);
  }

  const type = match[1].toLowerCase();
  const id = match[2];
  const isPlaylist = type === 'playlist';

  let response;
  try {
    response = await fetchFn(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  } catch (cause) {
    throw new SunoIngestError(`Suno sayfasına erişilemedi: ${cause.message}`);
  }

  if (!response.ok) {
    throw new SunoIngestError(`Suno sayfa yanıtı başarısız (HTTP ${response.status}). Linkin public olduğundan emin olun.`);
  }

  const html = await response.text();
  const clips = [];

  // Next.js JSON verisinden veya fallback regex ile clip bilgilerini çıkar
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (nextDataMatch) {
    try {
      const json = JSON.parse(nextDataMatch[1]);
      const pageProps = json?.props?.pageProps;

      if (isPlaylist && Array.isArray(pageProps?.playlist?.clips)) {
        for (const c of pageProps.playlist.clips) {
          if (c?.id) {
            clips.push({
              clipId: c.id,
              title: c.title || `Track-${c.id.substring(0, 8)}`,
              audioUrl: c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3`,
              duration: c.metadata?.duration,
            });
          }
        }
      } else if (pageProps?.clip?.id) {
        const c = pageProps.clip;
        clips.push({
          clipId: c.id,
          title: c.title || `Track-${c.id.substring(0, 8)}`,
          audioUrl: c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3`,
          duration: c.metadata?.duration,
        });
      }
    } catch {
      // JSON parse hatasında fallback mantığına devam et
    }
  }

  // Fallback: CDN ve clip ID deseni arama
  if (clips.length === 0) {
    if (!isPlaylist) {
      clips.push({
        clipId: id,
        title: `Track-${id.substring(0, 8)}`,
        audioUrl: `https://cdn1.suno.ai/${id}.mp3`,
      });
    } else {
      // Playlist için fallback clip UUID regex arama
      const uuidRegex = /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi;
      const matches = new Set(html.match(uuidRegex) || []);
      matches.delete(id); // Playlist ID'yi çıkar

      let index = 1;
      for (const clipId of matches) {
        clips.push({
          clipId,
          title: `Track-${index}`,
          audioUrl: `https://cdn1.suno.ai/${clipId}.mp3`,
        });
        index++;
      }
    }
  }

  if (clips.length === 0) {
    throw new SunoIngestError('Suno sayfasında indirilebilir müzik parçası bulunamadı.');
  }

  return { isPlaylist, id, clips };
}

/**
 * Public Suno playlist veya song linkinden metadata ve MP3'leri indirir.
 *
 * @param {object} params
 * @param {string} params.url - Suno public URL'i
 * @param {string} params.outputDir - MP3 dosyalarının kaydedileceği klasör (audio/)
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn] - Custom/Mock fetch
 * @param {typeof setTimeout} [options.sleepFn] - Custom/Mock delay
 * @returns {Promise<{ tracks: Array<{ index: number, clipId: string, title: string, audioUrl: string, duration?: number, localPath: string }> }>}
 */
export async function ingestSunoUrl({ url, outputDir } = {}, options = {}) {
  if (!outputDir) {
    throw new SunoIngestError('Çıktı klasörü (outputDir) belirtilmeli.');
  }

  const fetchFn = options.fetchFn || fetch;
  const { clips } = await parseSunoUrl(url, fetchFn);

  await mkdir(outputDir, { recursive: true });

  const resultTracks = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const index = i + 1;
    const prefix = String(index).padStart(2, '0');
    const safeTitle = sanitizeFilename(clip.title);
    const filename = `${prefix}-${safeTitle}.mp3`;
    const localPath = join(outputDir, filename);

    let audioResponse;
    try {
      audioResponse = await fetchFn(clip.audioUrl);
    } catch (cause) {
      throw new SunoIngestError(`Parça ${index} (${clip.title}) indirilemedi: ${cause.message}`);
    }

    if (!audioResponse.ok) {
      throw new SunoIngestError(`Parça ${index} (${clip.title}) indirme yanıtı başarısız (HTTP ${audioResponse.status}).`);
    }

    const arrayBuffer = await audioResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    await writeFile(localPath, buffer);

    resultTracks.push({
      index,
      clipId: clip.clipId,
      title: clip.title,
      audioUrl: clip.audioUrl,
      duration: clip.duration,
      localPath,
    });

    // Parçalar arası rate-limit için opsiyonel bekleme (testlerde sleepFn verilebilir)
    if (options.sleepFn && i < clips.length - 1) {
      await new Promise((res) => options.sleepFn(res, 1000));
    }
  }

  return { tracks: resultTracks };
}
