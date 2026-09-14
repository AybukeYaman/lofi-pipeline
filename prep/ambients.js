/**
 * Ortak ambient kütüphanesi — hangi ses efektleri var, ad → yol.
 *
 * Tek sorumluluk: ambient klasörünü taramak ve kısa adı ("heavyRain") dosyaya
 * eşlemek. Sesi ölçmez, karıştırmaz (onu steps/03-ambient-mix.js yapar).
 */

import { basename, extname } from 'node:path';

import { AUDIO_EXTENSIONS, listFiles } from '../core/files.js';

/** Albümlerin paylaştığı ses efektleri klasörü. `--ambient-dir` ezer. */
export const DEFAULT_AMBIENT_DIR = 'C:\\Users\\Aybuke Yeni\\Desktop\\Youtube\\ortak-ses efektleri';

export class AmbientError extends Error {
  /**
   * @param {string} message
   * @param {{ dir: string }} context
   */
  constructor(message, { dir }) {
    super(message);
    this.name = 'AmbientError';
    this.dir = dir;
  }
}

/**
 * Klasördeki ses dosyaları, doğal sırada. Alt klasörlere inmez.
 *
 * @param {string} [dir]
 * @returns {Promise<{ name: string, path: string }[]>} name: uzantısız dosya adı
 */
export async function listAmbients(dir = DEFAULT_AMBIENT_DIR) {
  let paths;
  try {
    paths = await listFiles(dir, AUDIO_EXTENSIONS);
  } catch (cause) {
    throw new AmbientError(`ambient klasörü okunamadı (${cause.code ?? cause.message}): ${dir}`, { dir });
  }
  return paths.map((path) => ({ name: basename(path, extname(path)), path }));
}

/**
 * Kısa adı listede arar. Büyük/küçük harfe duyarsız (Windows'ta `heavyrain`
 * ile `heavyRain` aynı dosya); uzantılı ad da kabul edilir.
 *
 * @param {{ name: string, path: string }[]} ambients listAmbients() çıktısı
 * @param {string} name
 * @returns {{ name: string, path: string } | null}
 */
export function findAmbient(ambients, name) {
  const wanted = name.trim().toLowerCase();
  return ambients.find((a) =>
    a.name.toLowerCase() === wanted || basename(a.path).toLowerCase() === wanted,
  ) ?? null;
}
