/**
 * UI-only sample data for screens that have no API yet (ambient library). Nothing here is read from or written to the pipeline; screens
 * that use it must show <SampleDataNotice />.
 */

export type LibraryAmbient = {
  id: string;
  name: string;
  category: string;
  isLocalDraft?: boolean;
  fileName?: string;
};

export const sampleAmbients: LibraryAmbient[] = [
  { id: 'gentleRain', name: 'gentleRain', category: 'Rain' },
  { id: 'heavyRain', name: 'heavyRain', category: 'Rain' },
  { id: 'rainStorm', name: 'rainStorm', category: 'Storm' },
  { id: 'campfire', name: 'campfire', category: 'Fire' },
];
