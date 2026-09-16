/**
 * İndirilenler klasörü adapter'ı — klasörün yerini bulma, anlık listeleme, taşıma.
 *
 * Tek sorumluluk: dosya sistemi ve Windows kayıt defteri erişimi. Hangi dosyanın
 * yeni/hazır olduğunu ve hangi track'e gideceğini bilmez (prep/download-watch.js, ui/actions.js).
 */

import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { uniqueFileName } from './files.js';

/** Windows "Downloads" bilinen klasör kimliği (kullanıcı klasörü taşımış olabilir). */
const DOWNLOADS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/**
 * İndirilenler klasörü: kayıt defteri, okunamazsa %USERPROFILE%\Downloads.
 * @param {{ execFn?: typeof execFileSync, env?: NodeJS.ProcessEnv, platform?: string }} [options]
 * @returns {string}
 */
export function resolveDownloadsDir({ execFn = execFileSync, env = process.env, platform = process.platform } = {}) {
  const fallback = join(env.USERPROFILE || homedir(), 'Downloads');
  if (platform !== 'win32') return fallback;
  try {
    const output = execFn('reg', ['query', SHELL_FOLDERS_KEY, '/v', DOWNLOADS_GUID], { encoding: 'utf8', windowsHide: true });
    const raw = String(output).match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim();
    if (!raw) return fallback;
    return raw.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
  } catch {
    return fallback;
  }
}

/**
 * Klasördeki dosyalar (alt klasörler hariç). Klasör yoksa boş; liste alınırken
 * silinen/erişilemeyen dosya atlanır (tarayıcı o an adını değiştiriyor olabilir).
 * @param {string} dir
 * @returns {Promise<Array<{ name: string, size: number, mtimeMs: number }>>}
 */
export async function snapshotDir(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const info = await stat(join(dir, entry.name));
      files.push({ name: entry.name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // bu arada kayboldu
    }
  }
  return files;
}

/**
 * Dosyayı taşır (kopyalamaz). Hedefte aynı ad varsa "Ad (1).mp3" olur.
 * Farklı sürücüdeyse (EXDEV) kopyalayıp kaynağı siler.
 * @param {string} src
 * @param {string} targetDir
 * @param {string} name istenen ad
 * @returns {Promise<string>} hedefteki son ad
 */
export async function moveFile(src, targetDir, name) {
  const finalName = await uniqueFileName(targetDir, name);
  const dest = join(targetDir, finalName);
  try {
    await rename(src, dest);
  } catch (cause) {
    if (cause.code !== 'EXDEV') throw cause;
    await copyFile(src, dest, constants.COPYFILE_EXCL);
    await unlink(src);
  }
  return finalName;
}
