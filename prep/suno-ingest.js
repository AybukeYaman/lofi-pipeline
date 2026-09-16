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

import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { SunoIngestError } from './suno-errors.js';

/** Zaman aşımları: asılı kalan bağlantı süreci süresiz tutmasın (indirme gövde okumayı da kapsar). */
export const PAGE_TIMEOUT_MS = 30000;
export const DOWNLOAD_TIMEOUT_MS = 180000;

const SUNO_URL_REGEX = /^https?:\/\/(?:www\.)?suno\.com\/(playlist|song|s)\/([A-Za-z0-9_-]+)/i;
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
  if (!match) return { clips: [], privateFlag: false };
  let pageProps;
  try {
    pageProps = JSON.parse(match[1])?.props?.pageProps;
  } catch {
    return { clips: [], privateFlag: false };
  }
  const source = isPlaylist ? pageProps?.playlist : pageProps?.clip;
  const privateFlag = source?.is_public === false;
  const raw = isPlaylist && Array.isArray(pageProps?.playlist?.clips)
    ? pageProps.playlist.clips.filter((c) => c?.id)
    : (pageProps?.clip?.id ? [pageProps.clip] : []);
  const clips = raw.filter((c) => usableAudioUrl(c.audio_url)).map((c) => ({
    clipId: c.id,
    title: c.title || `Track-${c.id.substring(0, 8)}`,
    audioUrl: c.audio_url,
    duration: c.metadata?.duration,
  }));
  const downloadDisabled = raw.some((c) => String(c.audio_url ?? '').includes('/forbidden'));
  return { clips, privateFlag, downloadDisabled };
}

/** Güncel biçim: RSC akışındaki kaçışlı JSON'dan clip'ler (sayfadaki sıra korunur). */
function clipsFromRsc(html, { isPlaylist, id }) {
  const text = html.replace(/\\+"/g, '"');
  const privateFlag = new RegExp(`"id":"${id}"[^]{0,4000}?"is_public":false`).test(text);

  const ids = isPlaylist
    ? [...new Set([...text.matchAll(new RegExp(`/1/clip/(${UUID})\\.(?:m4a|mp3)`, 'g'))].map((m) => m[1]))]
    : [id];

  const pageTitle = (html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').replace(/\s+by\s+.*$|\s*\|\s*Suno\s*$/g, '').trim();
  const clips = [];
  let downloadDisabled = false;
  for (const clipId of ids) {
    const rawAudio = text.match(new RegExp(`"id":"${clipId}"[^]{0,600}?"audio_url":"([^"]+)"`))?.[1];
    const audioUrl = usableAudioUrl(rawAudio);
    if (!audioUrl) {
      if (rawAudio?.includes('/forbidden')) downloadDisabled = true;
      continue;
    }
    const title = text.match(new RegExp(`"id":"${clipId}"[^]{0,6000}?"title":"([^"]*)"`))?.[1]
      || (!isPlaylist && pageTitle)
      || `Track-${clipId.substring(0, 8)}`;
    clips.push({ clipId, title, audioUrl });
  }
  return { clips, privateFlag, downloadDisabled };
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
    throw new SunoIngestError(`Desteklenmeyen Suno URL formatı: "${url}". Format "https://suno.com/song/<id>", "https://suno.com/playlist/<id>" veya "https://suno.com/s/<kod>" olmalı.`);
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
    throw new SunoIngestError(`Suno sayfasına erişilemedi: ${cause.message}`);
  }

  if ([401, 403, 404].includes(response.status)) {
    throw new SunoIngestError(`${NOT_PUBLIC_HINT} (HTTP ${response.status})`, { notPublic: true });
  }
  if (!response.ok) {
    throw new SunoIngestError(`Suno sayfa yanıtı başarısız (HTTP ${response.status}).`);
  }

  // Kısa link (/s/<kod>) yönlendirmeyle /song/<uuid> olur; tür ve kimlik son adresten okunur.
  const [, rawType, rawId] = (response.url || cleanUrl).match(SUNO_URL_REGEX) ?? cleanUrl.match(SUNO_URL_REGEX);
  const type = rawType.toLowerCase();
  if (type === 's') {
    throw new SunoIngestError(`${NOT_PUBLIC_HINT} (kısa link bir şarkıya yönlenmedi)`, { notPublic: true });
  }
  const isPlaylist = type === 'playlist';
  const id = rawId;

  const html = await response.text();
  const legacy = clipsFromNextData(html, isPlaylist);
  const found = legacy.clips.length > 0 || legacy.privateFlag || legacy.downloadDisabled;
  const { clips, privateFlag, downloadDisabled } = found ? legacy : clipsFromRsc(html, { isPlaylist, id });

  if (privateFlag) {
    throw new SunoIngestError(NOT_PUBLIC_HINT, { notPublic: true });
  }
  if (clips.length === 0 && downloadDisabled) {
    throw new SunoIngestError(DOWNLOAD_DISABLED_HINT, { downloadDisabled: true });
  }
  if (clips.length === 0) {
    throw new SunoIngestError(NOT_PUBLIC_HINT, { notPublic: true });
  }

  return { isPlaylist, id, clips };
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
    const extension = extname(new URL(clip.audioUrl).pathname).toLowerCase() === '.m4a' ? '.m4a' : '.mp3';
    const filename = `${prefix}-${safeTitle}${extension}`;
    const localPath = join(outputDir, filename);

    let audioResponse;
    try {
      audioResponse = await fetchFn(clip.audioUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (cause) {
      throw new SunoIngestError(`Parça ${index} (${clip.title}) indirilemedi: ${cause.message}`);
    }

    if ([401, 403].includes(audioResponse.status)) {
      throw new SunoIngestError(`Parça ${index} (${clip.title}): ${NOT_PUBLIC_HINT} (HTTP ${audioResponse.status})`, { notPublic: true });
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
