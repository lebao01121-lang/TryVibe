export const ATELIER_COLORS = {
  ivory: '#FBF7EF',
  cream: '#F4EBDA',
  champagne: '#EBD9B4',
  gold: '#B08A4A',
  goldHi: '#EBCF8F',
  goldDeep: '#8A672C',
  cocoa: '#1C1410',
  cocoa2: '#2A1E17',
  ink: '#2B2019',
  muted: '#7A6A5B',
} as const;

export type AtelierColorKey = keyof typeof ATELIER_COLORS;

export const ATELIER_SEMANTIC_COLORS = {
  surfacePage: ATELIER_COLORS.ivory,
  surfaceElevated: ATELIER_COLORS.cream,
  surfaceDark: ATELIER_COLORS.cocoa,
  surfaceDarkElevated: ATELIER_COLORS.cocoa2,
  statusInStock: '#2F5D46',
  statusLowStock: '#B87424',
  statusOutOfStock: '#9A3B3B',
  statusAiDraft: ATELIER_COLORS.goldDeep,
} as const;

export const ATELIER_TYPOGRAPHY = {
  serif: '"Cormorant Garamond", Georgia, serif',
  sans: '"Be Vietnam Pro", system-ui, sans-serif',
  cursive: '"Dancing Script", cursive',
  script: '"Dancing Script", cursive',
  googleFontFamilies: ['Cormorant Garamond', 'Be Vietnam Pro', 'Dancing Script'] as const,
} as const;

export const ATELIER_MOTION = {
  ease: 'cubic-bezier(0.22, 0.8, 0.22, 1)',
  durationFastMs: 240,
  durationBaseMs: 450,
  durationEditorialMs: 700,
} as const;

export interface AtelierOccasionTheme {
  readonly key: string;
  readonly name: string;
  readonly themeBg: string;
  readonly themeInk: string;
  readonly themeAccent: string;
  readonly isDark: boolean;
}

export const ATELIER_OCCASION_THEMES: readonly AtelierOccasionTheme[] = [
  {
    key: 'office',
    name: 'Công sở thanh lịch',
    themeBg: '#F4EBDA',
    themeInk: '#2B2019',
    themeAccent: '#8A672C',
    isDark: false,
  },
  {
    key: 'evening',
    name: 'Tiệc tối & Sự kiện',
    themeBg: '#1C1410',
    themeInk: '#FBF7EF',
    themeAccent: '#EBCF8F',
    isDark: true,
  },
  {
    key: 'weekend',
    name: 'Dạo phố cuối tuần',
    themeBg: '#ECEEEB',
    themeInk: '#24302C',
    themeAccent: '#5C736B',
    isDark: false,
  },
  {
    key: 'resort',
    name: 'Du lịch & Resort',
    themeBg: '#F7EFE3',
    themeInk: '#4A3525',
    themeAccent: '#B57D4C',
    isDark: false,
  },
  {
    key: 'ceremony',
    name: 'Cưới & Áo dài',
    themeBg: '#FAF6F0',
    themeInk: '#3A2622',
    themeAccent: '#B08A4A',
    isDark: false,
  },
  {
    key: 'minimal',
    name: 'Tối giản & Quà tặng',
    themeBg: '#F5ECE9',
    themeInk: '#3F2B28',
    themeAccent: '#A36B63',
    isDark: false,
  },
] as const;

export const ATELIER_TOKENS = {
  colors: ATELIER_COLORS,
  semantic: ATELIER_SEMANTIC_COLORS,
  typography: ATELIER_TYPOGRAPHY,
  motion: ATELIER_MOTION,
  occasionThemes: ATELIER_OCCASION_THEMES,
} as const;

export type AtelierTokens = typeof ATELIER_TOKENS;
