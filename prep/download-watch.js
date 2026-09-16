/**
 * İndirilenler izleyicisi — polling ile "yeni ve indirmesi bitmiş" dosyaları bulur.
 *
 * Neden fs.watch değil: Windows'ta olaylar çift/adsız gelebiliyor ve tarayıcılar
 * dosyayı önce geçici adla yazıp sonra adını değiştiriyor. Polling + boyut
 * kararlılığı hem güvenilir hem saf fonksiyonla test edilebilir.
 *
 * Başlangıçta klasörde duran dosyalardan yalnızca son RECENT_MS (15 dk) içinde inenler alınır.
 *
 * Tarayıcı davranışları:
 *   Chrome/Edge  "Ad.mp3.crdownload" → bitince "Ad.mp3"
 *   Firefox      0 baytlık "Ad.mp3" + "Ad.mp3.part" → bitince .part kalkar
 */

import { extname, join } from 'node:path';

import { snapshotDir } from '../core/downloads.js';

/** Bu uzantılı eşlik dosyası varsa indirme sürüyor demektir. */
export const PARTIAL_EXTENSIONS = ['.crdownload', '.part', '.tmp', '.download'];

/** Boyut bu süre boyunca değişmezse dosya hazır sayılır. */
export const STABLE_MS = 1500;

/**
 * Saf: önceki durum + yeni anlık görüntü → hazır dosya adları + yeni durum.
 *
 * @param {{ baseline: Set<string>, pending: Map<string, { size: number, since: number }> }} state
 *   baseline izleme başladığında var olan eski adlar (dokunulmaz, bkz. baselineOf)
 * @param {Array<{ name: string, size: number }>} snapshot
 * @param {{ now: number, extensions: string[], stableMs?: number }} options
 * @returns {{ ready: string[], state: typeof state }}
 */
export function diffSnapshots(state, snapshot, { now, extensions, stableMs = STABLE_MS }) {
  const names = new Set(snapshot.map((file) => file.name));
  const allowed = new Set(extensions.map((ext) => ext.toLowerCase()));
  const pending = new Map();
  const ready = [];

  for (const file of snapshot) {
    if (state.baseline.has(file.name)) continue;
    if (!allowed.has(extname(file.name).toLowerCase())) continue;
    if (file.size === 0 || PARTIAL_EXTENSIONS.some((ext) => names.has(file.name + ext))) continue;

    const previous = state.pending.get(file.name);
    if (previous && previous.size === file.size) {
      if (now - previous.since >= stableMs) ready.push(file.name);
      else pending.set(file.name, previous);
    } else {
      pending.set(file.name, { size: file.size, since: now });
    }
  }

  // Silinen başlangıç dosyası aynı adla yeniden inerse yeni sayılsın.
  const baseline = new Set([...state.baseline].filter((name) => names.has(name)));
  return { ready, state: { baseline, pending } };
}

/** İzleme başlarken bu süre içinde inmiş dosyalar da alınır (önce indir, sonra Auto Watch aç). */
export const RECENT_MS = 15 * 60 * 1000;

/** Panelde seçilebilen "son N dakika" pencereleri. */
export const RECENT_WINDOW_MINUTES = [5, 10, 15];

/** İndirilenler'den alınan ses uzantıları (Suno: mp3/wav, paylaşım siteleri: m4a). */
export const DOWNLOAD_AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.wav'];

/** İndirilenler'den alınan görsel uzantıları (Midjourney/DALL·E vb. png, webp de veriyor). */
export const DOWNLOAD_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * İndirilenler'den alınan klip uzantıları. Sadece .mp4: proje durumu (project-status)
 * videolar/ altında yalnızca .mp4 sayıyor, başka uzantı taşınsa da algılanmazdı.
 */
export const DOWNLOAD_VIDEO_EXTENSIONS = ['.mp4'];

/**
 * İndirilen dosya adını track adına çevirir: site etiketi ("[usesuno.com]") ve
 * tarayıcının tekrar indirme eki ("(1)") atılır.
 * @param {string} stem uzantısız dosya adı
 * @returns {string}
 */
export function cleanDownloadName(stem) {
  const cleaned = stem.replace(/\s*\[[^\]]*\]/g, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  return cleaned || stem;
}

/**
 * Başlangıçta var olan dosyalardan hangileri dokunulmaz (baseline) sayılır:
 * RECENT_MS'ten eski olanlar. Değiştirilme zamanı bilinmeyen dosya eski sayılır.
 * @param {Array<{ name: string, mtimeMs?: number }>} snapshot
 * @param {{ now: number, recentMs?: number }} options
 * @returns {Set<string>}
 */
export function baselineOf(snapshot, { now, recentMs = RECENT_MS }) {
  return new Set(snapshot.filter((file) => !(file.mtimeMs >= now - recentMs)).map((file) => file.name));
}

/**
 * @param {{
 *   dir: string, extensions?: string[], snapshotFn?: typeof snapshotDir,
 *   nowFn?: () => number, wallClockFn?: () => number, recentMs?: number,
 * }} options nowFn kararlılık saati (testte hızlandırılır); wallClockFn dosya zamanlarıyla karşılaştırılan gerçek saat
 * @returns {{ start(): Promise<void>, poll(): Promise<string[]> }} poll hazır dosyaların tam yollarını
 *   indirilme sırasıyla döndürür; taşınamayan (kilitli) dosya sonraki turlarda yeniden hazır olur
 */
export function createDownloadWatcher({
  dir, extensions = DOWNLOAD_AUDIO_EXTENSIONS, snapshotFn = snapshotDir, nowFn = Date.now, wallClockFn = Date.now, recentMs = RECENT_MS,
}) {
  let state = { baseline: new Set(), pending: new Map() };
  return {
    async start() {
      state = { baseline: baselineOf(await snapshotFn(dir), { now: wallClockFn(), recentMs }), pending: new Map() };
    },
    async poll() {
      const snapshot = await snapshotFn(dir);
      const result = diffSnapshots(state, snapshot, { now: nowFn(), extensions });
      state = result.state;
      const mtime = new Map(snapshot.map((file) => [file.name, file.mtimeMs ?? 0]));
      return result.ready
        .sort((a, b) => mtime.get(a) - mtime.get(b) || a.localeCompare(b))
        .map((name) => join(dir, name));
    },
  };
}
