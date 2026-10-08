/**
 * Ölçüm önbelleği + sınırlı paralellik.
 *
 * Pomodoro doğrulaması ve sıralama ekranı parça sürelerini okumak için her
 * dosyaya bir ffprobe çalıştırıyordu, üstelik SIRAYLA: 99 parçalık bir projede
 * `GET /api/projects/:id/pomodoro` 10-11 saniye sürüyordu ve arayüz
 * "Yükleniyor..." ekranında kalıyordu.
 *
 * İki değişiklik: ölçümler sınırlı sayıda paralel yürür ve sonuç dosyanın
 * kimliğine (yol + son değişiklik + boyut) göre saklanır. Dosya değişirse
 * anahtar da değişir, yani bayat ölçüm dönmez; dosya silinirse kayıt sadece
 * kullanılmaz. Süreç belleğinde durur, diske yazılmaz.
 */

import { stat } from 'node:fs/promises';

/** @type {Map<string, unknown>} */
const cache = new Map();

/** Önbellek sınırsız büyümesin: en eski kayıtlar düşer. */
const MAX_ENTRIES = 2000;

async function cacheKey(path) {
  const info = await stat(path);
  return `${path}|${info.mtimeMs}|${info.size}`;
}

/**
 * `probeFn(path)` sonucunu önbellekten döndürür, yoksa ölçüp saklar.
 * Ölçüm ya da `stat` hata verirse önbelleğe yazılmaz.
 *
 * @template T
 * @param {string} path
 * @param {(path: string) => Promise<T>} probeFn
 * @returns {Promise<T>}
 */
export async function probeCached(path, probeFn) {
  let key;
  try {
    key = await cacheKey(path);
  } catch {
    // Dosya okunamıyorsa önbelleğe girmeden ölçüme bırak: hatayı çağıran işler.
    return probeFn(path);
  }

  if (cache.has(key)) return /** @type {T} */ (cache.get(key));

  const result = await probeFn(path);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);
  return result;
}

/**
 * Listeyi en fazla `limit` iş paralel çalışacak şekilde eşler; sonuç sırası
 * girdiyle AYNI kalır (parça sırası ekranda bozulmasın).
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

