/**
 * Panelden CLI komutu çalıştırma — ayrı süreçte, terminali devrederek.
 *
 * Neden aynı süreçte main() değil: build.js çift Ctrl+C'de process.exit(130)
 * çağırıyor (paneli de öldürürdü) ve kırpma onayı için stdin'de kendi
 * readline'ını açıyor. Ayrı süreç,
 * test edilmiş CLI davranışını birebir korur.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Paneli başlatan süreç hâlâ yaşıyor mu?
 *
 * `npm start` + komut sırasında Ctrl+C: npm sinyali yalnızca ara `cmd.exe`'ye
 * iletir (Windows'ta kill = TerminateProcess, torun süreç etkilenmez) ve çıkar.
 * SIGINT'i yok sayan panel sahipsiz kalır, terminal girdisini kabukla paylaşır
 * ve her `npm start`'ta bir tane daha birikir. Bunu yakalamak için.
 *
 * @param {{ ppid?: number, killFn?: typeof process.kill }} [options]
 * @returns {boolean}
 */
export function isParentAlive({ ppid = process.ppid, killFn = process.kill } = {}) {
  try {
    killFn(ppid, 0); // sinyal 0: yalnızca varlık kontrolü
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // var ama erişim yok → yaşıyor
  }
}

/**
 * @param {string} script repo köküne göre betik (ör. "build.js")
 * @param {string[]} [args]
 * @param {{ cwd?: string, spawnFn?: typeof spawn }} [options]
 *   cwd repo kökü olmalı: betikler göreli yolları (ör. .env) buna göre çözer
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
