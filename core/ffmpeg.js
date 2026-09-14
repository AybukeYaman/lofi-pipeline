/**
 * ffmpeg / ffprobe süreç sarmalayıcısı.
 *
 * Tek sorumluluk: bir komutu çalıştır, çıktısını topla, hatayı anlaşılır hale getir.
 * Medya mantığı (filtre, codec, seviye) bilmez — onlar steps/ katmanının işi.
 */

import { spawn } from 'node:child_process';

/** Her ffmpeg çağrısına eklenen ön ek (terminal gürültüsü tuzağı). */
const FFMPEG_PREFIX = ['-hide_banner', '-loglevel', 'error', '-stats', '-nostdin'];

/** ffprobe'da -stats yok, stdout'u JSON olarak okuyacağımız için loglevel sessiz. */
const FFPROBE_PREFIX = ['-hide_banner', '-loglevel', 'error'];

/** Hata mesajında gösterilecek son stderr satırı sayısı. */
const STDERR_TAIL_LINES = 40;

/** Çalışan alt süreçler — iptal anında hepsini durdurabilmek için. */
const activeChildren = new Set();

/**
 * Çalışan tüm ffmpeg/ffprobe süreçlerini sonlandırır (Ctrl+C).
 * Bekleyen çağrılar FfmpegError ile reddedilir; çağıranın finally blokları
 * (workspace temizliği) normal şekilde çalışır.
 *
 * @returns {number} sonlandırılan süreç sayısı
 */
export function abortAll() {
  const count = activeChildren.size;
  for (const child of activeChildren) child.kill();
  return count;
}

/**
 * Windows'ta çıkış kodu işaretsiz 32-bit geliyor (-2 yerine 4294967294).
 * Okunabilir olması için işaretli değere çevir.
 * @param {number|null} code
 */
function normalizeExitCode(code) {
  if (code === null) return null;
  return code > 0x7fffffff ? code - 0x100000000 : code;
}

export class FfmpegError extends Error {
  /**
   * @param {string} message
   * @param {{ binary: string, args: string[], code: number|null, signal: string|null, stderr: string }} detail
   */
  constructor(message, detail) {
    super(message);
    this.name = 'FfmpegError';
    this.binary = detail.binary;
    this.args = detail.args;
    this.code = detail.code;
    this.signal = detail.signal;
    this.stderr = detail.stderr;
  }
}

/**
 * `-stats` satırlarındaki `time=00:01:23.45` damgasını saniyeye çevirir.
 * @param {string} line
 * @returns {number|null}
 */
function parseStatsTime(line) {
  const match = /time=\s*(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!match) return null;
  const [, sign, hours, minutes, seconds] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return sign === '-' ? 0 : total;
}

/**
 * Bir süreci çalıştırır ve tamamlanmasını bekler.
 *
 * Not: shell kullanılmaz. Argümanlar diziyle geçtiği için emojili veya boşluklu
 * yollar tırnaklama gerektirmez (bölüm 8, emojili klasör tuzağı).
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {object} [options]
 * @param {(seconds: number) => void} [options.onProgress] `-stats` ilerleme damgası
 * @param {string} [options.cwd]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.fullStderr] stderr'in tamamını döndür (bitstream izi gibi
 *   uzun çıktılar için). Hata mesajı yine son satırlarla sınırlı kalır.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function run(binary, args, options = {}) {
  const { onProgress, cwd, signal, fullStderr = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, signal, windowsHide: true });
    activeChildren.add(child);

    let stdout = '';
    const stderrTail = [];
    const stderrAll = [];
    let stderrBuffer = '';

    const pushStderr = (line) => {
      if (fullStderr) stderrAll.push(line);
      stderrTail.push(line);
      if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      // -stats satırları \r ile biter, hata satırları \n ile. İkisini de böl.
      const lines = stderrBuffer.split(/\r\n|\r|\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line === '') continue;
        const seconds = parseStatsTime(line);
        if (seconds !== null) {
          onProgress?.(seconds);
        } else {
          pushStderr(line);
        }
      }
    });

    child.on('error', (err) => {
      activeChildren.delete(child);
      if (err.code === 'ENOENT') {
        reject(new FfmpegError(
          `${binary} bulunamadı. PATH'te kurulu olduğundan emin ol (ffmpeg 9.0.1 bekleniyor).`,
          { binary, args, code: null, signal: null, stderr: '' },
        ));
        return;
      }
      reject(err);
    });

    child.on('close', (rawCode, closeSignal) => {
      activeChildren.delete(child);
      const code = normalizeExitCode(rawCode);
      if (stderrBuffer !== '') pushStderr(stderrBuffer);
      const stderr = stderrTail.join('\n');

      // Çıkış kodu kontrolü: yarım kalan dosyayı geçerli sanmamak için (bölüm 8).
      if (code !== 0) {
        const reason = closeSignal
          ? `sinyal ile sonlandı (${closeSignal})`
          : `çıkış kodu ${code}`;
        reject(new FfmpegError(
          `${binary} başarısız — ${reason}.\n${stderr || '(stderr boş)'}`,
          { binary, args, code, signal: closeSignal, stderr },
        ));
        return;
      }

      resolve({ code, stdout, stderr: fullStderr ? stderrAll.join('\n') : stderr });
    });
  });
}

/**
 * ffmpeg çağrısı. Standart ön ek otomatik eklenir.
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [options]
 */
export function ffmpeg(args, options) {
  return run('ffmpeg', [...FFMPEG_PREFIX, ...args], options);
}

/**
 * ffprobe çağrısı. Standart ön ek otomatik eklenir.
 * @param {string[]} args
 * @param {Parameters<typeof run>[2]} [options]
 */
export function ffprobe(args, options) {
  return run('ffprobe', [...FFPROBE_PREFIX, ...args], options);
}
