/**
 * Panelden CLI komutu çalıştırma — ayrı süreçte, terminali devrederek.
 *
 * Neden aynı süreçte main() değil: build.js çift Ctrl+C'de process.exit(130)
 * çağırıyor (paneli de öldürürdü) ve kırpma onayı için stdin'de kendi
 * readline'ını açıyor; add-style process.env'i değiştiriyor. Ayrı süreç,
 * test edilmiş CLI davranışını birebir korur.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} script repo köküne göre betik (ör. "build.js")
 * @param {string[]} [args]
 * @param {{ cwd?: string, spawnFn?: typeof spawn }} [options]
 *   cwd repo kökü olmalı: add-style .env'i process.cwd()'den okuyor
 * @returns {Promise<number>} çıkış kodu (sinyalle bittiyse 130, başlatılamadıysa 1)
 */
export function runScript(script, args = [], { cwd = REPO_ROOT, spawnFn = spawn } = {}) {
  return new Promise((resolveCode) => {
    // Ctrl+C konsoldaki bütün süreçlere gider: komut kendi iptalini yapar, panel açık kalır.
    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);

    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignoreSigint);
      resolveCode(code);
    };

    let child;
    try {
      child = spawnFn(process.execPath, [join(REPO_ROOT, script), ...args], { stdio: 'inherit', cwd });
    } catch (error) {
      process.stderr.write(`komut başlatılamadı (${script}): ${error.message}\n`);
      settle(1);
      return;
    }
    child.on('error', (error) => {
      process.stderr.write(`komut başlatılamadı (${script}): ${error.message}\n`);
      settle(1);
    });
    child.on('close', (code, signal) => settle(code ?? (signal ? 130 : 1)));
  });
}
