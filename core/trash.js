/**
 * Geri Dönüşüm Kutusu adapter'ı — klasörü kalıcı silmeden çöpe taşır.
 *
 * Tek sorumluluk: Windows kabuğuna erişim. Neyin silinebileceğine karar vermez
 * (server/project-api.js deleteProject). npm bağımlılığı yok: Windows'un kendi
 * Microsoft.VisualBasic FileSystem API'si PowerShell üzerinden çağrılır.
 */

import { spawn } from 'node:child_process';

export class TrashError extends Error {
  /**
   * @param {string} message
   * @param {{ path: string, cause?: unknown }} detail
   */
  constructor(message, { path, cause }) {
    super(message, { cause });
    this.name = 'TrashError';
    this.path = path;
  }
}

// Yol komuta gömülmez, ortam değişkeninden okunur: tırnak/özel karakter kaçışı gerekmez.
/** @param {'DeleteDirectory'|'DeleteFile'} method */
const scriptFor = (method) => [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:LOFI_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
].join('; ');

const SCRIPT = {
  dir: scriptFor('DeleteDirectory'),
  file: scriptFor('DeleteFile'),
};

/**
 * Klasörü Geri Dönüşüm Kutusu'na taşır.
 *
 * @param {string} dir mutlak klasör yolu
 * @param {{ spawnFn?: typeof spawn, platform?: string }} [options] testte sahte süreç için
 * @returns {Promise<void>}
 */
export function moveDirToTrash(dir, options = {}) {
  return toTrash(dir, { ...options, kind: 'dir' });
}

/**
 * Tek bir dosyayı Geri Dönüşüm Kutusu'na taşır.
 *
 * Ambiance sesleri için var: ortak klasördeki bir ses başka projelerin
 * project.json'unda yazılı olabilir, kalıcı silinirse geri alınamaz.
 *
 * @param {string} file mutlak dosya yolu
 * @param {{ spawnFn?: typeof spawn, platform?: string }} [options]
 * @returns {Promise<void>}
 */
export function moveFileToTrash(file, options = {}) {
  return toTrash(file, { ...options, kind: 'file' });
}

/**
 * İkisinin ortak gövdesi — PowerShell'i çağıran tek yer.
 *
 * @param {string} path
 * @param {{ kind: 'dir'|'file', spawnFn?: typeof spawn, platform?: string }} options
 * @returns {Promise<void>}
 */
function toTrash(path, { kind, spawnFn = spawn, platform = process.platform }) {
  const label = kind === 'dir' ? 'Klasör' : 'Dosya';
  if (platform !== 'win32') {
    return Promise.reject(new TrashError('Geri Dönüşüm Kutusu yalnızca Windows üzerinde destekleniyor.', { path }));
  }
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT[kind]], {
        env: { ...process.env, LOFI_TRASH_PATH: path },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      reject(new TrashError(`PowerShell başlatılamadı: ${cause.message}`, { path, cause }));
      return;
    }
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (cause) => reject(new TrashError(`PowerShell başlatılamadı: ${cause.message}`, { path, cause })));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new TrashError(`${label} çöpe taşınamadı (çıkış kodu ${code}): ${stderr.trim() || path}`, { path }));
    });
  });
}
