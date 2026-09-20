import { useEffect, useState } from 'react';

export type ThemeId =
  | 'vivid-contrast'
  | 'retro-earth'
  | 'calm-pastel'
  | 'dramatic-night'
  | 'pastel-autumn';

export type ThemeInfo = {
  id: ThemeId;
  name: string;
  description: string;
  colors: {
    primary: string;
    secondary?: string;
    dark?: string;
    light?: string;
    accent?: string;
  };
  previewColors: string[];
};

export const THEMES: readonly ThemeInfo[] = [
  {
    id: 'vivid-contrast',
    name: 'Canlı & Cesur Kontrast',
    description: 'Yüksek kontrastlı, enerjik ve odaklanmış modern kimlik',
    colors: {
      primary: '#D9256E',
      dark: '#1C3B47',
      light: '#F5F2EC',
    },
    previewColors: ['#D9256E', '#1C3B47', '#F5F2EC'],
  },
  {
    id: 'retro-earth',
    name: 'Retro & Toprak Tonları',
    description: 'Sıcak vintage hissi veren doğal zemin ve kehribar vurgular',
    colors: {
      primary: '#5C523B',
      secondary: '#D9A53B',
      accent: '#A63A2B',
    },
    previewColors: ['#5C523B', '#D9A53B', '#A63A2B'],
  },
  {
    id: 'calm-pastel',
    name: 'Sakin Pastel & Doğal',
    description: 'Yumuşak pudra, adaçayı ve dingin keten dokusu',
    colors: {
      primary: '#E6C7C2',
      secondary: '#9BB0A8',
      light: '#F2EFE9',
    },
    previewColors: ['#E6C7C2', '#9BB0A8', '#F2EFE9'],
  },
  {
    id: 'dramatic-night',
    name: 'Derin & Dramatik Gece',
    description: 'Gece mavisi ve zengin bordo zemin üstünde altın ışıltılar',
    colors: {
      primary: '#2B3E50',
      secondary: '#59232B',
      accent: '#C29B38',
    },
    previewColors: ['#2B3E50', '#59232B', '#C29B38'],
  },
  {
    id: 'pastel-autumn',
    name: 'Pastel Sonbahar',
    description: 'Kiremit, zeytin yeşili ve ılık kum beji armonisi',
    colors: {
      primary: '#C47D4E',
      secondary: '#8C8C6B',
      light: '#D6CEBE',
    },
    previewColors: ['#C47D4E', '#8C8C6B', '#D6CEBE'],
  },
] as const;

export const DEFAULT_THEME: ThemeId = 'vivid-contrast';
const STORAGE_KEY = 'lofi-app-theme';

export function getStoredTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null;
    if (saved && THEMES.some((t) => t.id === saved)) {
      return saved;
    }
  } catch {
    // localStorage may fail in strict sandbox
  }
  return DEFAULT_THEME;
}

export function applyTheme(themeId: ThemeId): void {
  const validTheme = THEMES.some((t) => t.id === themeId) ? themeId : DEFAULT_THEME;
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', validTheme);
  }
}

export function saveTheme(themeId: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    // ignore storage errors
  }
  applyTheme(themeId);
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const selectTheme = (newTheme: ThemeId) => {
    setThemeState(newTheme);
    saveTheme(newTheme);
  };

  return { theme, selectTheme, themes: THEMES };
}
