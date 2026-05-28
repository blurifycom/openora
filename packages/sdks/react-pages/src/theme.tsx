'use client';

import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from 'react';

/**
 * Theme tokens.
 *
 * Every token has a CSS custom property under `--bo-*` in `styles.css`. This
 * type is the runtime-overridable surface. The defaults below MUST stay in
 * sync with the `:root` block in `styles.css` so that the type system reflects
 * what's actually rendered when no overrides are provided.
 *
 * Future: a downstream consumer can fetch a row per igaming from the database,
 * shape it into `Partial<Theme>`, and pass it to <ThemeProvider>. No CSS edits
 * needed - everything cascades through `--bo-*` variables.
 */
export type Theme = {
  // Surfaces
  paper: string;
  ink: string;
  ink2: string;
  ink3: string;

  // Hairlines
  hairline: string;
  hairlineSoft: string;

  // Text
  bone: string;
  stone: string;
  stoneDim: string;
  ash: string;

  // Accent (single, used sparingly)
  accent: string;
  accentBright: string;
  accentDim: string;

  // Semantic
  success: string;
  destructive: string;
  warning: string;

  // Spatial
  sidebarWidth: string;
  contentMax: string;
  topbarHeight: string;
  radius: string;

  // Type
  fontDisplay: string;
  fontBody: string;
  fontMono: string;

  // Motion
  ease: string;
  easeOut: string;

  // Texture
  grainOpacity: string;
};

export const defaultTheme: Theme = {
  paper: '#1c1815',
  ink: '#262019',
  ink2: '#2f2820',
  ink3: '#392f26',

  hairline: '#46392e',
  hairlineSoft: '#332a22',

  bone: '#f7f1ea',
  stone: '#bcb6ad',
  stoneDim: '#8c847a',
  ash: '#5c554c',

  accent: '#c89c60',
  accentBright: '#e6c089',
  accentDim: '#836443',

  success: '#81a47e',
  destructive: '#c0654a',
  warning: '#d6a955',

  sidebarWidth: '232px',
  contentMax: '1240px',
  topbarHeight: '64px',
  radius: '2px',

  fontDisplay: "var(--font-display, 'Bricolage Grotesque'), ui-sans-serif, system-ui, sans-serif",
  fontBody:
    "var(--font-body, 'Hanken Grotesk'), ui-sans-serif, -apple-system, system-ui, sans-serif",
  fontMono: "var(--font-mono, 'JetBrains Mono'), ui-monospace, 'SF Mono', monospace",

  ease: 'cubic-bezier(0.32, 0.72, 0, 1)',
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',

  grainOpacity: '0.035',
};

/**
 * Preset palettes. Add more here as igamings onboard. Each preset is a
 * `Partial<Theme>` so you only specify what differs from the default.
 */
export const themePresets = {
  editorialBrass: {},
  midnightSapphire: {
    accent: '#8aa3d0',
    accentBright: '#b6c6e2',
    accentDim: '#52689a',
    paper: '#161c2b',
    ink: '#1f273a',
    ink2: '#28324a',
    ink3: '#323e58',
    hairline: '#3a4664',
    hairlineSoft: '#2a344c',
  },
  veronaCrimson: {
    accent: '#c06a62',
    accentBright: '#dc8e86',
    accentDim: '#854540',
    paper: '#20100e',
    ink: '#2b1815',
    ink2: '#351f1b',
    ink3: '#412824',
    hairline: '#503530',
    hairlineSoft: '#3b2622',
  },
  porcelain: {
    paper: '#f7f4ef',
    ink: '#ede8e0',
    ink2: '#e3dcd0',
    ink3: '#d8cfc0',
    hairline: '#c8bda9',
    hairlineSoft: '#dbd3c3',
    bone: '#1a1814',
    stone: '#54504a',
    stoneDim: '#7a7468',
    ash: '#a39d8f',
    accent: '#8b6e3c',
    accentBright: '#a98549',
    accentDim: '#5e4a28',
    grainOpacity: '0.02',
  },
} as const satisfies Record<string, Partial<Theme>>;

export type ThemePresetName = keyof typeof themePresets;

const ThemeContext = createContext<Theme>(defaultTheme);

/**
 * Wrap your app in `<ThemeProvider>` to override any subset of the design
 * tokens. The provider emits the active palette as CSS custom properties on
 * its own wrapping `<div>`, so any descendant inherits them.
 *
 * ```tsx
 * // Static override
 * <ThemeProvider theme={{ accent: '#cd853f' }}>{children}</ThemeProvider>
 *
 * // Preset
 * <ThemeProvider preset="midnightSapphire">{children}</ThemeProvider>
 *
 * // DB-driven (future)
 * const { data } = useQuery({ queryKey: ['theme', igamingId], ... });
 * <ThemeProvider theme={data}>{children}</ThemeProvider>
 * ```
 */
export function ThemeProvider({
  children,
  theme: themeOverride,
  preset,
}: {
  children: ReactNode;
  theme?: Partial<Theme>;
  preset?: ThemePresetName;
}) {
  const resolved = useMemo<Theme>(() => {
    const fromPreset = preset ? themePresets[preset] : {};
    return { ...defaultTheme, ...fromPreset, ...themeOverride };
  }, [preset, themeOverride]);

  return (
    <ThemeContext.Provider value={resolved}>
      <div style={themeToCssVars(resolved)}>{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * Convert a Theme to a `style` object full of `--bo-*` custom properties.
 * Useful if you want to inject the theme on the document root instead of a
 * wrapping div (eg via a `<style>` tag or `document.documentElement.style`).
 */
export function themeToCssVars(theme: Theme): CSSProperties {
  return {
    '--bo-paper': theme.paper,
    '--bo-ink': theme.ink,
    '--bo-ink-2': theme.ink2,
    '--bo-ink-3': theme.ink3,
    '--bo-hairline': theme.hairline,
    '--bo-hairline-soft': theme.hairlineSoft,
    '--bo-bone': theme.bone,
    '--bo-stone': theme.stone,
    '--bo-stone-dim': theme.stoneDim,
    '--bo-ash': theme.ash,
    '--bo-accent': theme.accent,
    '--bo-accent-bright': theme.accentBright,
    '--bo-accent-dim': theme.accentDim,
    '--bo-success': theme.success,
    '--bo-destructive': theme.destructive,
    '--bo-warning': theme.warning,
    '--bo-sidebar-w': theme.sidebarWidth,
    '--bo-content-max': theme.contentMax,
    '--bo-topbar-h': theme.topbarHeight,
    '--bo-radius': theme.radius,
    '--bo-font-display': theme.fontDisplay,
    '--bo-font-body': theme.fontBody,
    '--bo-font-mono': theme.fontMono,
    '--bo-ease': theme.ease,
    '--bo-ease-out': theme.easeOut,
    '--bo-grain-opacity': theme.grainOpacity,
  } as CSSProperties;
}
