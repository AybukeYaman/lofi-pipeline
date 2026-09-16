/**
 * Albüm konsept üreticisi (11b, 11f'de daraltıldı).
 *
 * Gemini YALNIZCA parça başlığı ve kısa atmosfer kelimeleri üretir. Yay
 * (album-arc.js) ve Suno stil dizesi (album-prompt.js) deterministik kodda
 * kalır — LLM asla ham Suno prompt'u yazmaz. Birleştirme: prep/album-chain.js.
 */

import { describeArcPhases, energyModifiers, phaseFor } from './album-arc.js';
import { AlbumPlanError } from './album-errors.js';
import { generateContent, GeminiError } from './gemini.js';

export const MAX_TRACKS = 20;

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
        },
        required: ['index', 'title', 'atmosphere'],
      },
    },
  },
  required: ['albumTitle', 'tracks'],
};

/**
 * Gemini'ye giden metin. Saf — test edilebilir.
 *
 * @param {{ concept: string, trackCount: number, styleContext?: string }} input
 * @returns {string}
 */
export function buildPlannerPrompt({ concept, trackCount, styleContext }) {
  const slots = Array.from({ length: trackCount }, (_, i) => {
    const phase = phaseFor(i, trackCount);
    const { tempo, density } = energyModifiers(phase.energy);
    return `Track ${i + 1}: ${phase.name} (${tempo}, ${density})`;
  }).join('\n');

  return `You are naming the tracks of a ${trackCount}-track instrumental lofi album around the concept: "${concept}".
${styleContext ? `Album sound (fixed, do not describe it again): ${styleContext}\n` : ''}
The album follows a night-to-morning energy arc. The quietest, most still moment is exactly in the middle (trough); the album opens moderately, sinks, then rises toward a warmer, brighter resolution:
${describeArcPhases()}

Each track's position on the arc is already fixed:
${slots}

For each track return:
- title: a short evocative title (max 60 characters), unique within the album, no quotes or brackets
- atmosphere: 2 to 5 English words describing the scene/emotion of that moment, matching its arc phase

Do NOT mention genre, instruments, tempo, vocals or production in the atmosphere. Do NOT write music prompts.`;
}

/** LLM metnini stil dizesine güvenle girecek hale getirir (meta etiket, fazla boşluk). */
export function cleanIdeaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[[\]{}<>"]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Gemini ile parça başlıkları ve atmosferleri.
 *
 * @param {object} params
 * @param {string} params.concept
 * @param {number} params.trackCount 1..MAX_TRACKS
 * @param {string} [params.styleContext] albüm DNA'sı — yalnızca bağlam olarak verilir
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchFn]
 * @param {typeof setTimeout} [options.sleepFn]
 * @param {string} [options.apiKey] Gemini API key
 * @param {string} [options.model]
 * @param {object} [options.env]
 * @returns {Promise<{ albumTitle: string, tracks: Array<{ index: number, title: string, atmosphere: string }> }>}
 * @throws {AlbumPlanError}
 */
export async function planTrackIdeas({ concept, trackCount, styleContext } = {}, options = {}) {
  if (typeof concept !== 'string' || concept.trim() === '') {
    throw new AlbumPlanError('Albüm konsepti boş olamaz.');
  }
  if (!Number.isInteger(trackCount) || trackCount < 1 || trackCount > MAX_TRACKS) {
    throw new AlbumPlanError(`Parça sayısı 1 ile ${MAX_TRACKS} arasında olmalı, verilen: ${trackCount}`);
  }

  let responseData;
  try {
    responseData = await generateContent({
      contents: [{ parts: [{ text: buildPlannerPrompt({ concept, trackCount, styleContext }) }] }],
      model: options.model,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ALBUM_RESPONSE_SCHEMA,
        temperature: 0.7,
      },
      apiKey: options.apiKey,
      options: { fetchFn: options.fetchFn, sleepFn: options.sleepFn, env: options.env },
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
  // Yay konumları parça sayısına göre sabitlendi; eksik/fazla liste yayı kaydırır.
  if (parsed.tracks.length !== trackCount) {
    throw new AlbumPlanError(`Gemini ${trackCount} yerine ${parsed.tracks.length} parça döndürdü.`);
  }

  const tracks = parsed.tracks.map((t, i) => {
    const index = i + 1;
    return {
      index,
      title: cleanIdeaText(t?.title) || `Track ${index}`,
      atmosphere: cleanIdeaText(t?.atmosphere) || cleanIdeaText(concept),
    };
  });

  return {
    albumTitle: cleanIdeaText(parsed.albumTitle) || concept.trim(),
    tracks,
  };
}
