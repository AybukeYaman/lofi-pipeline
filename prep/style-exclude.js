/**
 * Suno Exclude string generator.
 * Stil objesindeki veya dizideki exclude negatif etiketlerini birleştirir.
 */

import { cleanStyleString } from './style-cleaner.js';
import { StyleBuildError } from './style-errors.js';

/**
 * Negatif stil etiketlerini virgülle ayrılmış temiz bir exclude dizesine çevirir.
 *
 * @param {object|string[]} input - Stil objesi veya exclude dizisi
 * @returns {string} Cleaned exclude string
 * @throws {StyleBuildError} Girdi geçersizse
 */
export function buildExcludePrompt(input) {
  if (input === null || input === undefined) {
    return '';
  }

  let rawList = [];

  if (Array.isArray(input)) {
    rawList = input;
  } else if (typeof input === 'object') {
    if (input.exclude !== undefined) {
      if (Array.isArray(input.exclude)) {
        rawList = input.exclude;
      } else if (typeof input.exclude === 'string') {
        rawList = [input.exclude];
      } else {
        throw new StyleBuildError(`exclude alanı bir dizi veya metin olmalı, verilen: ${typeof input.exclude}`);
      }
    } else {
      return '';
    }
  } else if (typeof input === 'string') {
    rawList = [input];
  } else {
    throw new StyleBuildError(`Exclude girdisi bir dizi, obje veya metin olmalı, verilen: ${typeof input}`);
  }

  const items = [];
  for (const item of rawList) {
    if (typeof item === 'string' && item.trim() !== '') {
      items.push(item);
    }
  }

  return cleanStyleString(items.join(', '));
}
