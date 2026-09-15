/**
 * Albüm konsept üreticisi (11b).
 * Gemini API ile konsept + track sayısı alıp başlık ve atmosfer arkı üretir.
 * Üretilen değişkenler 11a fonksiyonlarından (buildStylePrompt, buildExcludePrompt) geçirilerek
 * Suno prompt'ları hazırlanır.
 */

import { generateContent, GeminiError } from './gemini.js';
import { loadStyle } from './styles.js';
import { buildStylePrompt } from './style-builder.js';
import { buildExcludePrompt } from './style-exclude.js';
import { AlbumPlanError } from './album-errors.js';

const ALBUM_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    albumTitle: { type: 'STRING' },
    tracks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          title: { type: 'STRING' },
          atmosphere: { type: 'STRING' },
          additionalMoods: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
          additionalInstruments: {
            type: 'ARRAY',
            items: { type: 'STRING' },
          },
        },
        required: ['index', 'title', 'atmosphere'],
      },
    },
  },
  required: ['albumTitle', 'tracks'],
};

/**
 * Gemini ile albüm konsepti ve track listesi planlar, 11a filtresinden geçirir.
 *
 * @param {object} params
 * @param {string} params.concept - Albüm konusu/konsepti
 * @param {string} params.styleName - Stil adı (styles/<name>.json okumak için)
 * @param {number} [params.trackCount=8] - Üretilecek parça sayısı (1-20 arası)
 * @param {object} [options]
 * @param {string} [options.stylesDir] - Stil klasör yolu
 * @param {typeof fetch} [options.fetchFn] - Mock/Custom fetch
 * @param {typeof setTimeout} [options.sleepFn]
 * @param {string} [options.apiKey] - Gemini API Key
 * @param {string} [options.model] - Gemini Model adı
 * @param {object} [options.env]
 * @returns {Promise<{ concept: string, styleName: string, albumTitle: string, tracks: Array<{ index: number, title: string, atmosphere: string, stylePrompt: string, excludePrompt: string }> }>}
 * @throws {AlbumPlanError}
 */
export async function planAlbum({ concept, styleName, trackCount = 8 } = {}, options = {}) {
  if (typeof concept !== 'string' || concept.trim() === '') {
    throw new AlbumPlanError('Albüm konsepti boş olamaz.');
  }

  if (typeof styleName !== 'string' || styleName.trim() === '') {
    throw new AlbumPlanError('Stil adı belirtilmeli.');
  }

  const numTracks = Number(trackCount);
  if (isNaN(numTracks) || numTracks < 1 || numTracks > 20) {
    throw new AlbumPlanError(`Parça sayısı 1 ile 20 arasında olmalı, verilen: ${trackCount}`);
  }

  let styleObj;
  try {
    const loaded = await loadStyle(styleName, { dir: options.stylesDir });
    styleObj = loaded.style;
  } catch (cause) {
    throw new AlbumPlanError(`Stil okunamadı (${styleName}): ${cause.message}`);
  }

  const systemPrompt = `You are a music producer planning a ${numTracks}-track Lofi album around the concept: "${concept}".
Style Context: Genre: ${styleObj.genre || 'lo-fi'}, Default Instruments: ${(styleObj.instruments || []).join(', ')}.

Create a cohesive sequence of ${numTracks} track titles and emotional atmospheres that follow a natural arc (intro, build, peak, wind-down, outro).
For each track, suggest optional additional moods or instruments that fit that specific track's atmosphere.`;

  const generationConfig = {
    responseMimeType: 'application/json',
    responseSchema: ALBUM_RESPONSE_SCHEMA,
    temperature: 0.7,
  };

  let responseData;
  try {
    responseData = await generateContent({
      contents: [{ parts: [{ text: systemPrompt }] }],
      model: options.model,
      generationConfig,
      apiKey: options.apiKey,
      options: {
        fetchFn: options.fetchFn,
        sleepFn: options.sleepFn,
        env: options.env,
      },
    });
  } catch (cause) {
    if (cause instanceof GeminiError) {
      throw new AlbumPlanError(`Gemini planlama hatası: ${cause.message}`);
    }
    throw cause;
  }

  const candidateText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText) {
    throw new AlbumPlanError('Gemini geçerli bir plan üretemedi (boş yanıt).');
  }

  let parsed;
  try {
    parsed = JSON.parse(candidateText);
  } catch {
    throw new AlbumPlanError('Gemini yanıtı geçerli bir JSON olarak ayrıştırılamadı.');
  }

  if (!parsed || !Array.isArray(parsed.tracks) || parsed.tracks.length === 0) {
    throw new AlbumPlanError('Gemini yanıtında tracks listesi bulunamadı.');
  }

  const tracks = [];
  const baseExclude = buildExcludePrompt(styleObj);

  for (let i = 0; i < parsed.tracks.length; i++) {
    const t = parsed.tracks[i];
    const index = i + 1;
    const title = t.title || `Track ${index}`;
    const atmosphere = t.atmosphere || concept;

    // Stil nesnesinin bir kopyasını oluştur ve varyasyonları ekle
    const trackStyleObj = {
      ...styleObj,
      mood: [...(styleObj.mood || [])],
      instruments: [...(styleObj.instruments || [])],
    };

    if (Array.isArray(t.additionalMoods)) {
      trackStyleObj.mood.push(...t.additionalMoods.filter((m) => typeof m === 'string'));
    }
    if (Array.isArray(t.additionalInstruments)) {
      trackStyleObj.instruments.push(...t.additionalInstruments.filter((inst) => typeof inst === 'string'));
    }

    const stylePrompt = buildStylePrompt(trackStyleObj);

    tracks.push({
      index,
      title,
      atmosphere,
      stylePrompt,
      excludePrompt: baseExclude,
    });
  }

  return {
    concept,
    styleName,
    albumTitle: parsed.albumTitle || concept,
    tracks,
  };
}
