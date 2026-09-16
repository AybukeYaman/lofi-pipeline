/**
 * UI-only sample data for screens that have no API yet (style and ambient
 * libraries). Nothing here is read from or written to the pipeline; screens
 * that use it must show <SampleDataNotice />.
 */

export type LibraryStyle = {
  id: string;
  name: string;
  description: string;
  palette: [string, string, string];
  suggestedAmbient: string[];
  isLocalDraft?: boolean;
};

export type LibraryAmbient = {
  id: string;
  name: string;
  category: string;
  isLocalDraft?: boolean;
  fileName?: string;
};

export const sampleStyles: LibraryStyle[] = [
  {
    id: 'anime-cel',
    name: 'Anime Cel',
    description: 'Flat cel shading, soft evening light, quiet city windows.',
    palette: ['#2f3a56', '#c98b6b', '#f1d9b5'],
    suggestedAmbient: ['gentleRain'],
  },
  {
    id: 'cozy-realistic',
    name: 'Cozy Realistic',
    description: 'Warm interior light, shallow depth of field, lived-in rooms.',
    palette: ['#3b2f28', '#a8764f', '#e8d4b8'],
    suggestedAmbient: ['campfire'],
  },
  {
    id: 'watercolor',
    name: 'Watercolor',
    description: 'Soft washes, paper texture, muted pastel tones.',
    palette: ['#5d7485', '#b9a5c4', '#efe6d8'],
    suggestedAmbient: ['heavyRain'],
  },
  {
    id: 'custom-generated',
    name: 'Custom (from references)',
    description: 'Style block generated from your own reference images.',
    palette: ['#44403a', '#8f8678', '#d9d2c6'],
    suggestedAmbient: [],
  },
];

export const sampleAmbients: LibraryAmbient[] = [
  { id: 'gentleRain', name: 'gentleRain', category: 'Rain' },
  { id: 'heavyRain', name: 'heavyRain', category: 'Rain' },
  { id: 'rainStorm', name: 'rainStorm', category: 'Storm' },
  { id: 'campfire', name: 'campfire', category: 'Fire' },
];
