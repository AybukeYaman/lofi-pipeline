/**
 * Aynı kayda iki isteğin birlikte yazmasını engeller (kütüphane API'leri ortak kullanır).
 *
 * `createExclusive('Prompt is being updated')` bir `exclusive(id, fn)` döndürür:
 * aynı `id` için bir iş sürerken ikincisi 409 alır, iş bitince (hata olsa da) kilit kalkar.
 */

import { ApiError } from './project-api.js';

/** @param {string} busyMessage 409 ile dönen ileti */
export function createExclusive(busyMessage) {
  const writing = new Set();

  return async function exclusive(id, fn) {
    if (writing.has(id)) throw new ApiError(409, busyMessage);
    writing.add(id);
    try {
      return await fn();
    } finally {
      writing.delete(id);
    }
  };
}
