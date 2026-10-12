/**
 * Müzik klasöründeki zip'leri açar — "zip'i klasöre at, parçalar gelsin".
 *
 * İki yoldan aynı iş: kullanıcı zip'i `audio/` klasörüne kendisi bırakır (sayfa
 * yenilenince açılır) ya da arayüzden yükler (yükleme zip'i klasöre yazar, sonra
 * burası açar). Açılan zip `audio/zip-arsivi/` altına taşınır: tekrar açılmaz,
 * ama silinmez de (kaynak kullanıcının, biz yalnızca okuyoruz).
 *
 * Kurallar:
 *   - Yalnızca müzik dosyaları alınır (`AUDIO_EXTENSIONS`); kapak resmi, .txt,
 *     macOS `__MACOSX/._x.mp3` artıkları ve klasörler atlanır.
 *   - Klasör yapısı düzleştirilir: yalnızca dosya adı kullanılır. Zip içindeki
 *     `../../x.mp3` gibi yollar bu yüzden klasör dışına yazamaz.
 *   - Aynı adda parça varsa ezilmez, `ad (1).mp3` olur.
 *   - Parçalar zip içindeki sırayla değil, doğal sırayla (01, 02, … 10) eklenir:
 *     "Eklediğim sıra" öngörülebilir olsun.
 *   - Bir zip ya tamamen açılır ya hiç: yarıda hata olursa o zip'ten gelen parçalar
 *     silinir, zip yerinde kalır ve sorun raporlanır (diğer zip'ler etkilenmez).
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { ZipError, extractZipEntry, listZipEntries } from '../core/zip.js';
import { AUDIO_EXTENSIONS, listFiles, naturalCompare, uniqueFileName } from '../core/files.js';

/** Açılmış zip'lerin taşındığı alt klasör (müzik listesi alt klasörlere bakmaz). */
export const ZIP_ARCHIVE_DIR = 'zip-arsivi';

/** Windows'ta dosya adı olamayan adlar (uzantısız kısım). */
const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Aynı klasör için eşzamanlı açma yarışını önler (sayfa iki kez yüklenirse parçalar ikilenmesin). */
const running = new Map();

/**
 * @typedef {object} UnpackResult
 * @property {string[]} files klasöre eklenen yeni parçalar (ekleniş sırasıyla)
 * @property {Array<{ zip: string, files: string[], error?: string, noAudio?: boolean }>} archives
 */

/**
 * `audioDir` içindeki (alt klasörler hariç) bütün .zip'leri açar.
 * Hata atmaz: sorunlar `archives[].error` olarak döner.
 *
 * @param {string} audioDir
 * @returns {Promise<UnpackResult>}
 */
export async function unpackAudioZips(audioDir) {
  const pending = running.get(audioDir);
  if (pending) {
    await pending;
    return { files: [], archives: [] };
  }

  const job = unpack(audioDir);
  running.set(audioDir, job);
  try {
    return await job;
  } finally {
    running.delete(audioDir);
  }
}

/** Klasörde açılmamış zip var mı — açmadan sormak için (ucuz: tek readdir). */
export async function hasAudioZips(audioDir) {
  try {
    return (await listFiles(audioDir, ['.zip'])).length > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function unpack(audioDir) {
  /** @type {UnpackResult} */
  const result = { files: [], archives: [] };

  let zips;
  try {
    zips = await listFiles(audioDir, ['.zip']);
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }

  for (const zipPath of zips) {
    const archive = { zip: basename(zipPath), files: [] };
    result.archives.push(archive);

    try {
      const entries = (await listZipEntries(zipPath))
        .map((entry) => ({ entry, name: audioNameOf(entry) }))
        .filter((item) => item.name !== null)
        .sort((a, b) => naturalCompare(a.name, b.name));

      if (entries.length === 0) {
        archive.noAudio = true;
      } else {
        try {
          for (const { entry, name } of entries) {
            const finalName = await uniqueFileName(audioDir, name);
            const destPath = join(audioDir, finalName);
            try {
              await extractZipEntry(zipPath, entry, destPath);
            } catch (error) {
              await rm(destPath, { force: true }); // yarım yazılan dosya (CRC/boyut hatası) kalmasın
              throw error;
            }
            archive.files.push(finalName);
          }
        } catch (error) {
          // Ya hep ya hiç: bu zip'ten gelenleri geri al.
          for (const name of archive.files) await rm(join(audioDir, name), { force: true });
          archive.files = [];
          throw error;
        }
      }
    } catch (error) {
      archive.error = error instanceof ZipError ? error.message : `Zip açılamadı: ${error.message}`;
      continue; // zip yerinde kalır: kullanıcı görsün, düzeltsin
    }

    // Açıldı (ya da içinde müzik yok): tekrar tekrar bakılmasın diye arşive taşı.
    const archiveDir = join(audioDir, ZIP_ARCHIVE_DIR);
    await mkdir(archiveDir, { recursive: true });
    await rename(zipPath, join(archiveDir, await uniqueFileName(archiveDir, basename(zipPath))));
    result.files.push(...archive.files);
  }

  return result;
}

/**
 * Zip girdisinin müzik klasörüne yazılacak adı; alınmayacaksa null.
 * Klasör yolu atılır (düzleştirme = zip-slip'e karşı da koruma), geçersiz
 * karakterler `_` olur.
 *
 * @param {import('../core/zip.js').ZipEntry} entry
 * @returns {string|null}
 */
export function audioNameOf(entry) {
  if (entry.isDirectory) return null;
  const parts = entry.name.split(/[\\/]/);
  if (parts.includes('__MACOSX')) return null;

  const raw = parts.at(-1) ?? '';
  if (raw === '' || raw.startsWith('.')) return null;

  const ext = extname(raw).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) return null;

  // eslint-disable-next-line no-control-regex
  let stem = raw.slice(0, raw.length - ext.length).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (stem === '') return null;
  if (RESERVED_NAMES.test(stem)) stem = `_${stem}`;
  return `${stem}${ext}`;
}
