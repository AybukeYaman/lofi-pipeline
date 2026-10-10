/**
 * UI-only sample data for screens that have no API yet (ambient library). Nothing here is read from or written to the pipeline; screens
 * that use it must show <SampleDataNotice />.
 */

export type LibraryAmbient = {
  id: string;
  name: string;
  category: string;
};

export const sampleAmbients: LibraryAmbient[] = [
  { id: 'gentleRain', name: 'gentleRain', category: 'Yağmur' },
  { id: 'heavyRain', name: 'heavyRain', category: 'Yağmur' },
  { id: 'rainStorm', name: 'rainStorm', category: 'Fırtına' },
  { id: 'campfire', name: 'campfire', category: 'Ateş' },
];
