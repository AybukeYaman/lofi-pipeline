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
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:LOFI_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')",
].join('; ');

/**
 * Klasörü Geri Dönüşüm Kutusu'na taşır.
 *
 * @param {string} dir mutlak klasör yolu
 * @param {{ spawnFn?: typeof spawn, platform?: string }} [options] testte sahte süreç için
 * @returns {Promise<void>}
 */
export function moveDirToTrash(dir, { spawnFn = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return Promise.reject(new TrashError('Geri Dönüşüm Kutusu yalnızca Windows\'ta destekleniyor.', { path: dir }));
  }
  return new Promise((resolvePromise, reject) => {
    let stderr = '';
    let child;
    try {
      child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
        env: { ...process.env, LOFI_TRASH_PATH: dir },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (cause) {
      reject(new TrashError(`PowerShell başlatılamadı: ${cause.message}`, { path: dir, cause }));
      return;
    }
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (cause) => reject(new TrashError(`PowerShell başlatılamadı: ${cause.message}`, { path: dir, cause })));
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new TrashError(`Klasör çöpe taşınamadı (çıkış kodu ${code}): ${stderr.trim() || dir}`, { path: dir }));
    });
  });
}
