/**
 * Music Generation Planner & AI Prompt Generator — Concept-driven album music planner.
 *
 * Her yeni video projesi için, seçilen concept + style yapısını analiz eder:
 * 1. AI (Gemini API) mevcutsa meta prompt ile 17 adet benzersiz track ve prompt üretir.
 * 2. Çevrimdışı/Fallback durumunda concept decomposition ile dynamic benzersiz albüm planı oluşturur.
 * 3. Her track title benzersizdir ve her prompt kendi title'ını ve [Instrumental] etiketini içerir.
 */

import { generateContent, getApiKey } from './gemini.js';

export class MusicPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MusicPlanError';
  }
}

/**
 * AI Meta Prompt (Section 18).
 */
export const SYSTEM_META_PROMPT = `
You are creating the complete instrumental music plan for a concept-driven YouTube album.

Analyze the album concept deeply before creating tracks.

Create a coherent musical journey rather than a collection of unrelated songs.

Every track must:
- belong clearly to the album concept
- have a unique title
- have a distinct musical identity
- contribute something new to the album
- preserve the overall style
- avoid repeating another track's instrumentation, structure, mood, or wording unless repetition is intentionally meaningful
- reflect a specific scene, moment, emotion, or narrative function
- contain its exact title in the generated music prompt
- be directly usable in an AI music generator
- remain instrumental when the project requires instrumental music

Do not generate 17 variations of the same prompt.
Do not merely replace adjectives between tracks.
Do not use generic titles unrelated to the concept.

Think about the album as one continuous experience from the first track to the final track.
The final track should provide an appropriate sense of resolution based on the concept.

Return JSON in the exact format:
{
  "albumDirection": "overall description...",
  "tracks": [
    {
      "number": 1,
      "title": "exact title",
      "scene": "scene description",
      "emotion": "emotional tone",
      "musicalIdentity": "instruments, tempo, rhythm",
      "prompt": "[Instrumental] Style: ... Concept: ... Track 01: \"exact title\" ..."
    }
  ]
}
`.trim();

/**
 * Concept-based keyword decomposition dictionaries for offline / fallback generation.
 */
const CONCEPT_DICTIONARIES = [
  {
    keywords: ['night', 'sleep', '2:17', 'midnight', 'asleep', 'dark', 'insomnia', 'gece', 'uyku'],
    scenes: [
      { arc: 'Intro / Setting Scene', titles: ['2:17 AM', 'The Quiet Hour', 'Lights Across the Bay', 'Midnight Arrival'], instruments: 'warm vintage Rhodes, vinyl crackle, distant city ambient hum' },
      { arc: 'Solitude & Quiet', titles: ['The Apartment Is Quiet', 'Streetlights Through the Blinds', 'Clock Ticking in the Hall', 'Ceiling Shadows'], instruments: 'mellow upright piano, tape pitch-drift, deep sub-bass pulse' },
      { arc: 'Memories & Thoughts', titles: ['Unsent Messages', 'Coffee Cooling on the Desk', 'Faded Photographs', 'Echoes of Earlier'], instruments: 'delicate acoustic guitar, soft brush snare, subtle rain texture' },
      { arc: 'Late Hour Wandering', titles: ['Empty Avenue', 'Night Bus Home', 'Quiet Distances', 'Solitary Walk'], instruments: 'spacey analog synth pads, muted trumpet accents, relaxed hip-hop groove' },
      { arc: 'Resolution & Rest', titles: ['Drifting Off', 'Before Dawn', 'First Light', 'Peaceful Silence'], instruments: 'soft decaying piano chords fading into quiet ambient room tone' },
    ],
  },
  {
    keywords: ['tokyo', 'neon', 'city', 'japan', 'street', 'train', 'vending', 'rainy', 'sokak'],
    scenes: [
      { arc: 'Arrival in Neon', titles: ['Shinjuku Neon Rain', 'Midnight Vending Machine', 'Last Train to Shibuya', 'Crosswalk Reflection'], instruments: 'dusty lo-fi keys, warm synth bass, soft rain field recordings' },
      { arc: 'Alleyways & Lights', titles: ['Lanterns in Omoide Yokocho', 'Under the Railway Track', 'Quiet Izakaya Glow', 'Rooftop Over Looking Tokyo'], instruments: 'mellow electric piano, gentle koto-inspired synth motif, relaxed boom-bap beat' },
      { arc: 'Night City Glides', titles: ['Yamanote Line Loop', 'Neon Reflections on Wet Asphalt', 'Akihabara Side Alley', 'Distant Highway Hum'], instruments: 'tape-saturated Rhodes, subtle vinyl crackle, soft rimshot rhythm' },
      { arc: 'Inner Thoughts in the City', titles: ['Convenience Store Coffee', 'Tower Lights Distant', 'Tokyo Fog at 3 AM', 'Sleepless In Shibuya'], instruments: 'warm acoustic guitar plucks, sub-bass warmth, ambient city soundscape' },
      { arc: 'Morning Light over Skyscraper', titles: ['Sunrise over Sumida', 'Tokyo Morning Mist', 'Station Gates Opening', 'New Day Awakening'], instruments: 'peaceful piano arpeggio, soft pad wash, gentle shaker rhythm' },
    ],
  },
  {
    keywords: ['coffee', 'morning', 'sunday', 'sunlight', 'cozy', 'sun', 'sabah', 'kahve'],
    scenes: [
      { arc: 'Morning Awakening', titles: ['Sunday Morning Coffee', 'Sunbeams on the Table', 'First Sip of Warmth', 'Kitchen Window Light'], instruments: 'soft acoustic guitar strumming, gentle vinyl static, warm piano chords' },
      { arc: 'Quiet Home Moments', titles: ['Steam Rising Slow', 'Turning the Page', 'Morning Breeze in the Curtains', 'Peaceful Kitchen'], instruments: 'mellow Rhodes piano, slow head-nod beat, subtle room ambient' },
      { arc: 'Relaxation & Ease', titles: ['Lazy Breakfast', 'Dust Motes in Sunlight', 'Radio Playing Softly', 'Sipping Earl Grey'], instruments: 'cozy upright piano, warm low-pass bass, soft brushed drums' },
      { arc: 'Daydreaming & Warmth', titles: ['Warm Blanket Nostalgia', 'Garden Birds Outside', 'Quiet Hour Reading', 'Soft Sunlight Glow'], instruments: 'chill lofi guitar melody, vintage sampled pads, light shaker' },
      { arc: 'Peaceful Afternoon Transition', titles: ['Afternoon Shadows', 'Golden Hour Approaching', 'Restful Heart', 'Sunday Farewell'], instruments: 'soft acoustic guitar and piano duet, gentle ambient trail' },
    ],
  },
];

/**
 * Async music plan generator — API (Gemini) or dynamic decomposition fallback.
 *
 * @param {{ concept?: string, style?: string, totalTracks?: number }} input
 * @param {object} [options]
 * @returns {Promise<{ concept: string, style: string, totalTracks: number, completedCount: number, albumDirection?: string, tracks: Array<{ number: number, title: string, prompt: string, status: string, file: string | null }> }>}
 */
export async function generateMusicPlanAsync({ concept = '2:17 AM — Everyone Is Asleep', style = 'Lo-fi / mellow / instrumental', totalTracks = 17 } = {}, options = {}) {
  const count = Math.max(1, Math.min(50, Number(totalTracks) || 17));
  const apiKey = getApiKey(options.env || process.env);

  if (apiKey) {
    try {
      const userPrompt = `
Album Concept: "${concept}"
Style: "${style}"
Total Tracks Required: ${count}

Please create the complete album music plan following all system rules. Return valid JSON only.
`.trim();

      const response = await generateContent({
        contents: [
          { role: 'user', parts: [{ text: `${SYSTEM_META_PROMPT}\n\n${userPrompt}` }] },
        ],
        apiKey,
        options,
      });

      const responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (responseText) {
        const cleanJson = responseText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleanJson);
        if (parsed && Array.isArray(parsed.tracks) && parsed.tracks.length === count) {
          const tracks = parsed.tracks.map((t, idx) => {
            const num = idx + 1;
            const padNum = String(num).padStart(2, '0');
            const title = String(t.title || `Track ${padNum}`).trim();
            let prompt = String(t.prompt || '').trim();

            if (!prompt.includes('[Instrumental]')) prompt = `[Instrumental] ${prompt}`;
            if (!prompt.includes(title)) prompt = `${prompt} Track ${padNum}: "${title}".`;

            return {
              number: num,
              title,
              prompt,
              status: 'pending',
              file: null,
            };
          });

          const plan = {
            concept,
            style,
            totalTracks: count,
            completedCount: 0,
            albumDirection: parsed.albumDirection || `Concept-driven album: ${concept}`,
            tracks,
          };

          validateTrackPlan(plan);
          return plan;
        }
      }
    } catch {
      // Fallback silently if API call fails or JSON parse is invalid
    }
  }

  // Fallback to synchronous concept decomposition generator
  return generateMusicPlan({ concept, style, totalTracks: count });
}

/**
 * Synchronous dynamic music plan generator (concept decomposition).
 *
 * @param {{ concept?: string, style?: string, totalTracks?: number }} input
 * @returns {{ concept: string, style: string, totalTracks: number, completedCount: number, tracks: Array<{ number: number, title: string, prompt: string, status: string, file: string | null }> }}
 */
export function generateMusicPlan({ concept = '2:17 AM — Everyone Is Asleep', style = 'Lo-fi / mellow / instrumental', totalTracks = 17 } = {}) {
  const count = Math.max(1, Math.min(50, Number(totalTracks) || 17));
  const conceptLower = concept.toLowerCase();

  // Match concept dictionary or create a dynamic dictionary based on concept string
  let matchedDict = CONCEPT_DICTIONARIES.find((dict) =>
    dict.keywords.some((kw) => conceptLower.includes(kw))
  );

  if (!matchedDict) {
    const rawTitle = concept.split('—')[0].trim();
    matchedDict = {
      keywords: [rawTitle.toLowerCase()],
      scenes: [
        { arc: 'Album Intro', titles: [`${rawTitle} — Intro`, 'Opening Reflections', 'Setting the Scene', 'First Atmosphere'], instruments: 'warm dusty Rhodes piano, vinyl crackle, soft ambient hum' },
        { arc: 'Developing Atmosphere', titles: ['Quiet Moments', 'Ears to the Wind', 'Deepening Mood', 'Subtle Reflections'], instruments: 'mellow upright piano, tape pitch-drift, deep sub-bass pulse' },
        { arc: 'Introspective Core', titles: ['Inner Thoughts', 'Echoing Memories', 'Shadows on the Wall', 'Soft Whispers'], instruments: 'delicate acoustic guitar, soft brush snare, subtle room tone' },
        { arc: 'Late Phase Wandering', titles: ['Solitary Journey', 'Quiet Distances', 'Stillness in Motion', 'Night Horizon'], instruments: 'spacey analog synth pads, muted trumpet, slow hip-hop groove' },
        { arc: 'Resolution & Closing', titles: ['Drifting Rest', 'Before the Dawn', 'Peaceful Resolution', 'Final Echo'], instruments: 'soft decaying piano chords fading into gentle silence' },
      ],
    };
  }

  const usedTitles = new Set();
  const tracks = [];

  for (let i = 0; i < count; i++) {
    const trackNum = i + 1;
    const progress = i / Math.max(1, count - 1); // 0.0 to 1.0

    let sceneIndex = 0;
    if (progress >= 0.85) sceneIndex = 4;
    else if (progress >= 0.60) sceneIndex = 3;
    else if (progress >= 0.30) sceneIndex = 2;
    else if (progress >= 0.10) sceneIndex = 1;

    const sceneGroup = matchedDict.scenes[sceneIndex];

    let title = sceneGroup.titles.find((t) => !usedTitles.has(t));
    if (!title) {
      for (const sg of matchedDict.scenes) {
        title = sg.titles.find((t) => !usedTitles.has(t));
        if (title) break;
      }
    }
    if (!title) {
      title = `${concept.split('—')[0].trim()} — Part ${trackNum}`;
    }
    usedTitles.add(title);

    const padNum = String(trackNum).padStart(2, '0');
    const instruments = sceneGroup.instruments;

    const prompt = `[Instrumental] Style: ${style}. Concept: ${concept}. Track ${padNum}: "${title}". Atmosphere: ${sceneGroup.arc}. Instrumentation: ${instruments}. Pure instrumental lo-fi composition, no vocals, no lyrics.`;

    tracks.push({
      number: trackNum,
      title,
      prompt,
      status: 'pending',
      file: null,
    });
  }

  const plan = {
    concept,
    style,
    totalTracks: count,
    completedCount: 0,
    status: 'in_progress',
    tracks,
  };

  validateTrackPlan(plan);
  return plan;
}

/**
 * Parça planının kurallara uygunluğunu denetler.
 * @param {ReturnType<typeof generateMusicPlan>} plan
 */
export function validateTrackPlan(plan) {
  if (!plan || !Array.isArray(plan.tracks) || plan.tracks.length === 0) {
    throw new MusicPlanError('Müzik planı boş veya geçersiz.');
  }

  const titles = new Set();
  const prompts = new Set();

  for (const track of plan.tracks) {
    if (!track.title || typeof track.title !== 'string') {
      throw new MusicPlanError(`Track ${track.number}: Başlık eksik.`);
    }
    if (titles.has(track.title)) {
      throw new MusicPlanError(`Yinelenen track başlığı tespit edildi: ${track.title}`);
    }
    titles.add(track.title);

    if (!track.prompt || typeof track.prompt !== 'string') {
      throw new MusicPlanError(`Track ${track.number}: Prompt eksik.`);
    }
    if (!track.prompt.includes('[Instrumental]')) {
      throw new MusicPlanError(`Track ${track.number}: Prompt [Instrumental] etiketi içermelidir.`);
    }
    if (!track.prompt.includes(track.title)) {
      throw new MusicPlanError(`Track ${track.number}: Prompt içinde track başlığı ("${track.title}") geçmelidir.`);
    }
    if (prompts.has(track.prompt)) {
      throw new MusicPlanError(`Yinelenen prompt tespit edildi: Track ${track.number}`);
    }
    prompts.add(track.prompt);
  }
  return true;
}
