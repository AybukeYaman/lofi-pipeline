/**
 * Suno Style Prompt Builder.
 * Stil objesinden genre -> instruments -> mood -> vocal -> production sırasına göre
 * temizlenmiş bir Suno Style dizesi üretir.
 */

import { cleanStyleString } from './style-cleaner.js';
import { StyleBuildError } from './style-errors.js';

/**
 * Validated/Parsed style objesinden Suno Style dizesi üretir.
 *
 * Sıralama: genre -> instruments -> mood -> vocal -> production
 *
 * @param {object} style - Stil tanım objesi
 * @returns {string} Temizlenmiş Suno Style dizesi
 * @throws {StyleBuildError} Girdi geçerli bir obje değilse veya sonuç boş kalırsa
 */
export function buildStylePrompt(style) {
  if (style === null || typeof style !== 'object' || Array.isArray(style)) {
    throw new StyleBuildError(`Stil girdisi geçerli bir nesne olmalı, verilen: ${JSON.stringify(style)}`);
  }

  const parts = [];

  // 1. genre (string)
  if (typeof style.genre === 'string' && style.genre.trim() !== '') {
    parts.push(style.genre.trim());
  }

  // 2. instruments (array of strings)
  if (Array.isArray(style.instruments)) {
    for (const inst of style.instruments) {
      if (typeof inst === 'string' && inst.trim() !== '') {
        parts.push(inst.trim());
      }
    }
  } else if (typeof style.instruments === 'string' && style.instruments.trim() !== '') {
    parts.push(style.instruments.trim());
  }

  // 3. mood (array of strings)
  if (Array.isArray(style.mood)) {
    for (const m of style.mood) {
      if (typeof m === 'string' && m.trim() !== '') {
        parts.push(m.trim());
      }
    }
  } else if (typeof style.mood === 'string' && style.mood.trim() !== '') {
    parts.push(style.mood.trim());
  }

  // 4. vocal (string)
  if (typeof style.vocal === 'string' && style.vocal.trim() !== '') {
    parts.push(style.vocal.trim());
  }

  // 5. production (array of strings)
  if (Array.isArray(style.production)) {
    for (const prod of style.production) {
      if (typeof prod === 'string' && prod.trim() !== '') {
        parts.push(prod.trim());
      }
    }
  } else if (typeof style.production === 'string' && style.production.trim() !== '') {
    parts.push(style.production.trim());
  }

  const rawJoined = parts.join(', ');
  const result = cleanStyleString(rawJoined);

  if (result === '') {
    throw new StyleBuildError('Stil girdisinden geçerli bir Suno Style dizesi üretilemedi (tüm alanlar boş).');
  }

  return result;
}
