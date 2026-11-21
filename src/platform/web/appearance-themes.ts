import type { ThemeStyle, ThemeStyleTokens } from "@pablozaiden/webapp/contracts";
import { type AppearancePreference, type CustomTheme } from "@/contracts/schemas/appearance";

interface Palette {
  canvas: string;
  sidebar: string;
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  highlight: string;
  radius: string;
  controls: string;
  borders?: "0" | "1px";
}

function palette(p: Palette): ThemeStyleTokens {
  return {
    "--wapp-shell-bg": p.canvas, "--wapp-content-bg": p.canvas,
    "--wapp-header-bg": p.canvas, "--wapp-sidebar-bg": p.sidebar,
    "--wapp-surface": p.surface, "--wapp-surface-raised": p.surface,
    "--wapp-surface-muted": p.sidebar, "--wapp-surface-inset": p.canvas,
    "--wapp-text": p.text, "--wapp-sidebar-text": p.text,
    "--wapp-muted": p.muted, "--wapp-muted-2": p.muted,
    "--wapp-border": p.border, "--wapp-border-soft": p.border, "--wapp-border-muted": p.border,
    "--wapp-primary": p.accent, "--wapp-action-border": p.accent,
    "--wapp-action-bg": p.highlight, "--wapp-action-text": p.text,
    "--wapp-surface-pill": p.highlight, "--wapp-pill-text": p.text,
    "--wapp-sidebar-hover-bg": p.highlight, "--wapp-sidebar-section-hover-bg": p.highlight,
    "--wapp-sidebar-active-bg": p.highlight, "--wapp-sidebar-active-text": p.text,
    "--wapp-panel-radius": p.radius, "--wapp-control-radius": p.controls,
    "--wapp-panel-border-width": p.borders ?? "1px",
    "--wapp-control-border-width": "1px", "--wapp-sidebar-border-width": p.borders ?? "1px",
  };
}

export interface AppearanceTheme {
  id: string;
  name: string;
  style?: ThemeStyle;
  css?: string;
}

export const BUILT_IN_THEMES: readonly AppearanceTheme[] = [
  { id: "clanky", name: "Clanky" },
  { id: "graphite", name: "Graphite", style: {
    light: palette({ canvas: "#f6f7f9", sidebar: "#eceef1", surface: "#ffffff", text: "#20242b", muted: "#596371", border: "#d0d5dd", accent: "#345477", highlight: "#dbe3ec", radius: "4px", controls: "4px" }),
    dark: palette({ canvas: "#111315", sidebar: "#0b0d0f", surface: "#1a1d21", text: "#f3f5f7", muted: "#a5adb8", border: "#353b43", accent: "#bfccd9", highlight: "#2c343e", radius: "4px", controls: "4px" }),
  } },
  { id: "nord", name: "Nord", style: {
    light: palette({ canvas: "#edf2f7", sidebar: "#dde6ef", surface: "#f9fbfe", text: "#233445", muted: "#52667b", border: "#c2d0df", accent: "#285c80", highlight: "#caddeb", radius: "12px", controls: "8px" }),
    dark: palette({ canvas: "#1b2432", sidebar: "#151d29", surface: "#253245", text: "#e6edf7", muted: "#a9bad0", border: "#3d5069", accent: "#91c9df", highlight: "#31475e", radius: "12px", controls: "8px" }),
  } },
  { id: "sand", name: "Sand", style: {
    light: palette({ canvas: "#f6f1e7", sidebar: "#ece2d0", surface: "#fffaf1", text: "#3b3028", muted: "#756453", border: "#ddd0ba", accent: "#89501f", highlight: "#e5d6ba", radius: "16px", controls: "10px", borders: "0" }),
    dark: palette({ canvas: "#211c17", sidebar: "#191510", surface: "#30281f", text: "#f3e8d5", muted: "#beac92", border: "#514332", accent: "#e4bd7b", highlight: "#4b3b27", radius: "16px", controls: "10px", borders: "0" }),
  } },
  { id: "forest", name: "Forest", style: {
    light: palette({ canvas: "#eff5ee", sidebar: "#deeadd", surface: "#fafff8", text: "#243c2c", muted: "#536c59", border: "#b9d1be", accent: "#266044", highlight: "#c8e3cc", radius: "10px", controls: "6px" }),
    dark: palette({ canvas: "#111d18", sidebar: "#0c1612", surface: "#1b2c23", text: "#e0f0e2", muted: "#9dbda7", border: "#355141", accent: "#95d4ad", highlight: "#294d38", radius: "10px", controls: "6px" }),
  } },
  { id: "plum", name: "Plum", style: {
    light: palette({ canvas: "#f7f0fa", sidebar: "#ecdef2", surface: "#fffaff", text: "#422a4b", muted: "#795e82", border: "#dcc8e3", accent: "#79458e", highlight: "#e6cfef", radius: "20px", controls: "12px", borders: "0" }),
    dark: palette({ canvas: "#221627", sidebar: "#190f1e", surface: "#33203b", text: "#f4e5fa", muted: "#c0a3cd", border: "#56365f", accent: "#d4a0ed", highlight: "#51305f", radius: "20px", controls: "12px", borders: "0" }),
  } },
];

export function appearanceThemes(preference: AppearancePreference): readonly AppearanceTheme[] {
  return [...BUILT_IN_THEMES, ...preference.customThemes];
}

export function selectedAppearanceTheme(preference: AppearancePreference): AppearanceTheme {
  const theme = appearanceThemes(preference).find(({ id }) => id === preference.selected);
  if (!theme) throw new Error("The selected theme is not available.");
  return theme;
}

export function isCustomTheme(theme: AppearanceTheme): theme is CustomTheme {
  return !BUILT_IN_THEMES.some(({ id }) => theme.id === id);
}
