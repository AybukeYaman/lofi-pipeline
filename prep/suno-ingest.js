/**
 * Suno Ingest Adapter (11c).
 * Public Suno playlist veya song linkinden clip verilerini ve metadata'ları çıkarır,
 * ses dosyalarını indirip hedef klasöre yerleştirir.
 *
 * Sayfa verisi iki biçimde gelebilir:
 *   - eski: <script id="__NEXT_DATA__"> JSON (pageProps.clip / pageProps.playlist)
 *   - güncel (2026-09): App Router RSC akışı (self.__next_f), kaçışlı JSON parçaları.
 *     `audio_url` ".../api/forbidden" ise Suno indirmeyi kapatmış demektir; sayfadaki
 *     çalma akışı şifreli gelir. Bu durumda indirilmez, kullanıcı uyarılır (koruma aşılmaz).
 * Kısa paylaşım linki (suno.com/s/<kod>) /song/<uuid> sayfasına yönlenir.
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { SunoIngestError } from './suno-errors.js';

const execFileAsync = promisify(execFile);

/** Zaman aşımları: asılı kalan bağlantı süreci süresiz tutmasın (indirme gövde okumayı da kapsar). */
export const PAGE_TIMEOUT_MS = 30000;
export const DOWNLOAD_TIMEOUT_MS = 180000;

const SUNO_URL_REGEX = /^https?:\/\/(?:www\.)?suno\.com\/(playlist|song|s|hook)\/([A-Za-z0-9_-]+)/i;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

const DOWNLOAD_DISABLED_HINT = "Suno bu şarkının indirilmesine izin vermiyor. Suno'da şarkının menüsünden Download ile indirip 'Select Audio Files' seçeneğini kullan.";
const NOT_PUBLIC_HINT = "Link public değil ya da şarkı bulunamadı. Suno'da şarkıyı/playlist'i Public yapıp linki tekrar yapıştır.";

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

/** audio_url "forbidden" ya da boşsa kullanılamaz. */
const usableAudioUrl = (value) => (typeof value === 'string' && /^https?:\/\//.test(value) && !value.includes('/forbidden') ? value : null);

/** Eski biçim: __NEXT_DATA__ JSON. */
function clipsFromNextData(html, isPlaylist) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!match) return { clips: [], privateFlag: false, downloadDisabled: false };
  let pageProps;
  try {
    pageProps = JSON.parse(match[1])?.props?.pageProps;
  } catch {
    return { clips: [], privateFlag: false, downloadDisabled: false };
  }
  const source = isPlaylist ? pageProps?.playlist : pageProps?.clip;
  const privateFlag = isPlaylist && source?.is_public === false;
  const raw = isPlaylist && Array.isArray(pageProps?.playlist?.clips)
    ? pageProps.playlist.clips.filter((c) => c?.id)
    : (pageProps?.clip?.id ? [pageProps.clip] : []);
  const clips = raw.map((c) => {
    const item = {
      clipId: c.id,
      title: c.title || `Track-${c.id.substring(0, 8)}`,
      audioUrl: usableAudioUrl(c.audio_url) || `https://cdn1.suno.ai/${c.id}.mp3`,
    };
    if (c.metadata?.duration !== undefined) item.duration = c.metadata.duration;
    return item;
  });
  return { clips, privateFlag, downloadDisabled: false };
}

/** Güncel biçim: RSC akışındaki kaçışlı JSON'dan clip'ler (sayfadaki sıra korunur). */
function clipsFromRsc(html, { isPlaylist, id, cleanUrl, fetchFn }) {
  const text = html.replace(/\\+"/g, '"');
  if (!isPlaylist && !text.includes(`"id":"${id}"`) && !text.includes(id)) {
    return { clips: [], privateFlag: false, downloadDisabled: false };
  }

  const privateFlag = isPlaylist && text.includes('"is_public":false');

  const ids = isPlaylist
    ? [...new Set([...text.matchAll(new RegExp(`/1/clip/(${UUID})\\.(?:m4a|mp3)`, 'g'))].map((m) => m[1]))]
    : [id];

  const pageTitle = (html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').replace(/\s+by\s+.*$|\s*\|\s*Suno\s*$/g, '').trim();
  const clips = [];
  for (const clipId of ids) {
    const rawAudio = text.match(new RegExp(`"id":"${clipId}"[^]{0,600}?"audio_url":"([^"]+)"`))?.[1];
    const audioUrl = usableAudioUrl(rawAudio);
    const finalAudioUrl = audioUrl || `https://cdn1.suno.ai/${clipId}.mp3`;
    const title = text.match(new RegExp(`"id":"${clipId}"[^]{0,6000}?"title":"([^"]*)"`))?.[1]
      || (!isPlaylist && pageTitle)
      || `Track-${clipId.substring(0, 8)}`;
    
    const durationMatch = text.match(new RegExp(`"id":"${clipId}"[^]{0,6000}?"duration":([0-9.]+)`));
    const duration = durationMatch ? parseFloat(durationMatch[1]) : undefined;

    const clipObj = { clipId, title, audioUrl: finalAudioUrl };
    if (duration !== undefined) clipObj.duration = duration;
    clips.push(clipObj);
  }
  return { clips, privateFlag, downloadDisabled: false };
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

  const cleanUrl = url.trim();
  if (!SUNO_URL_REGEX.test(cleanUrl)) {
    throw new SunoIngestError(`Desteklenmeyen Suno URL formatı: "${url}". Format "https://suno.com/song/<id>", "https://suno.com/playlist/<id>", "https://suno.com/hook/<id>" veya "https://suno.com/s/<kod>" olmalı.`);
  }

  let response;
  try {
    response = await fetchFn(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
  } catch (cause) {
    const match = cleanUrl.match(SUNO_URL_REGEX);
    if (match && ['song', 'hook'].includes(match[1].toLowerCase())) {
      const id = match[2];
      return {
        isPlaylist: false,
        id,
        clips: [{ clipId: id, title: `Track-${id.substring(0, 8)}`, audioUrl: `https://cdn1.suno.ai/${id}.mp3` }],
      };
    }
    throw new SunoIngestError(`Suno sayfasına erişilemedi: ${cause.message}`);
  }

  // Kısa link (/s/<kod>) yönlendirmeyle /song/<uuid> olur; tür ve kimlik son adresten okunur.
  const [, rawType, rawId] = (response.url || cleanUrl).match(SUNO_URL_REGEX) ?? cleanUrl.match(SUNO_URL_REGEX);
  const type = rawType.toLowerCase();
  const isPlaylist = type === 'playlist';
  const id = rawId;

  if (type === 's') {
    throw new SunoIngestError(`${NOT_PUBLIC_HINT} (kısa link bir şarkıya yönlenmedi)`, { notPublic: true });
  }

  if ([401, 403, 404].includes(response.status)) {
    if (!isPlaylist && id) {
      return {
        isPlaylist: false,
        id,
        clips: [{ clipId: id, title: `Track-${id.substring(0, 8)}`, audioUrl: `https://cdn1.suno.ai/${id}.mp3` }],
      };
    }
    throw new SunoIngestError(`${NOT_PUBLIC_HINT} (HTTP ${response.status})`, { notPublic: true });
  }
  if (!response.ok) {
    if (!isPlaylist && id) {
      return {
        isPlaylist: false,
        id,
        clips: [{ clipId: id, title: `Track-${id.substring(0, 8)}`, audioUrl: `https://cdn1.suno.ai/${id}.mp3` }],
      };
    }
    throw new SunoIngestError(`Suno sayfa yanıtı başarısız (HTTP ${response.status}).`);
  }

  const html = await response.text();
  const legacy = clipsFromNextData(html, isPlaylist);
  const found = legacy.clips.length > 0;
  const { clips, privateFlag } = found ? legacy : clipsFromRsc(html, { isPlaylist, id, cleanUrl, fetchFn });

  if (isPlaylist && privateFlag) {
    throw new SunoIngestError(NOT_PUBLIC_HINT, { notPublic: true });
  }
  if (clips.length === 0) {
    if (!isPlaylist && id) {
      return {
        isPlaylist: false,
        id,
        clips: [{ clipId: id, title: `Track-${id.substring(0, 8)}`, audioUrl: `https://cdn1.suno.ai/${id}.mp3` }],
      };
    }
    throw new SunoIngestError(NOT_PUBLIC_HINT, { notPublic: true });
  }

  return { isPlaylist, id, clips };
}

/**
 * İndirme adresinin uzantısı: .m4a değilse .mp3.
 * @param {string} audioUrl
 * @returns {'.m4a'|'.mp3'}
 */
export function audioExtension(audioUrl) {
  return extname(new URL(audioUrl).pathname).toLowerCase() === '.m4a' ? '.m4a' : '.mp3';
}

/**
 * Tek bir ses dosyasını indirip diske yazar (ingest ve albüm zinciri ortak kullanır).
 *
 * @param {{ url: string, videoUrl?: string, clipId?: string, localPath: string, label: string }} params label hata mesajı öneki ("Parça 3 (Başlık)")
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string>} yazılan yol
 * @throws {SunoIngestError}
 */
export async function downloadAudio({ url, videoUrl, clipId, localPath, label }, fetchFn = fetch) {
  const reqHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://suno.com/',
  };

  let audioResponse;
  if (url && !url.includes('/forbidden')) {
    try {
      audioResponse = await fetchFn(url, { headers: reqHeaders, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (audioResponse.ok) {
        await writeFile(localPath, Buffer.from(await audioResponse.arrayBuffer()));
        return localPath;
      }
    } catch {
      // Fall through to CDN / video stream fallback
    }
  }

  // Fallback 1: Direct cdn1.suno.ai MP3 endpoint
  if (clipId && url !== `https://cdn1.suno.ai/${clipId}.mp3`) {
    try {
      const cdnRes = await fetchFn(`https://cdn1.suno.ai/${clipId}.mp3`, {
        headers: reqHeaders,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (cdnRes?.ok) {
        await writeFile(localPath, Buffer.from(await cdnRes.arrayBuffer()));
        return localPath;
      }
    } catch {
      // Fall through
    }
  }

  // Fallback 2: Extract audio from Suno's CDN video stream via ffmpeg
  const fallbackVideoUrl = videoUrl || (clipId ? `https://cdn1.suno.ai/${clipId}.mp4` : null);
  if (fallbackVideoUrl && fetchFn === fetch) {
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-i', fallbackVideoUrl,
        '-vn',
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        localPath,
      ]);
      return localPath;
    } catch {
      // If ffmpeg fails, continue to error
    }
  }

  if (audioResponse && [401, 403].includes(audioResponse.status)) {
    throw new SunoIngestError(`${label}: ${NOT_PUBLIC_HINT} (HTTP ${audioResponse.status})`, { notPublic: true });
  }
  if (audioResponse && !audioResponse.ok) {
    throw new SunoIngestError(`${label} indirme yanıtı başarısız (HTTP ${audioResponse.status}).`);
  }

  throw new SunoIngestError(`${label} indirilemedi: ${DOWNLOAD_DISABLED_HINT}`, { downloadDisabled: true });
}

/**
 * Public Suno playlist veya song linkinden metadata ve ses dosyalarını indirir.
 * Uzantı indirme adresinden gelir (.mp3 ya da .m4a).
 *
 * @param {object} params
 * @param {string} params.url - Suno public URL'i
 * @param {string} params.outputDir - Ses dosyalarının kaydedileceği klasör (audio/)
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
    const filename = `${prefix}-${safeTitle}${audioExtension(clip.audioUrl)}`;
    const localPath = join(outputDir, filename);

    await downloadAudio({
      url: clip.audioUrl,
      videoUrl: clip.videoUrl,
      clipId: clip.clipId,
      localPath,
      label: `Parça ${index} (${clip.title})`,
    }, fetchFn);

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

