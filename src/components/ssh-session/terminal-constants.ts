import { FitAddon, init, Terminal } from "ghostty-web";

export const TERMINAL_FONT_SIZE_PX = 16;
export const TERMINAL_SYMBOL_FONT_FAMILIES = [
  "Liga SFMono Nerd Font",
  "MesloLGS NF",
  "MonaspiceNe Nerd Font Mono",
  "MonaspiceXe Nerd Font Mono",
  "Iosevka Nerd Font",
  "RecMonoLinear Nerd Font Mono",
  "Terminess Nerd Font Mono",
  "FiraCode Nerd Font Mono",
  "CaskaydiaMono Nerd Font Mono",
  "CaskaydiaCove Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "Hack Nerd Font Mono",
  "SauceCodePro Nerd Font Mono",
  "Symbols Nerd Font Mono",
  "Symbols Nerd Font",
] as const;
export const TERMINAL_BUNDLED_NERD_FONT_FAMILIES = ["Ralpher Terminal Nerd Font"] as const;
export const TERMINAL_TEXT_FONT_FAMILIES = [
  "Ralpher Terminal Nerd Font",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "SFMono-Regular",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Liberation Mono",
] as const;
export const TERMINAL_GLYPH_SAMPLE = "\ue62b\uf07b\uf15b\uf002";

function formatTerminalFontFamily(fontFamily: string) {
  return fontFamily === "monospace" || !fontFamily.includes(" ") ? fontFamily : `"${fontFamily}"`;
}

export function buildTerminalFontFamily(fontFamilies: readonly string[]) {
  return [...new Set(fontFamilies)].map((fontFamily) => formatTerminalFontFamily(fontFamily)).join(", ");
}

// Use one patched mono font for both text and symbols whenever possible. Mixing
// system text fonts with Nerd Font fallbacks creates uneven cell metrics in TUIs.
export const TERMINAL_FONT_FAMILY = buildTerminalFontFamily([
  ...TERMINAL_TEXT_FONT_FAMILIES,
  ...TERMINAL_SYMBOL_FONT_FAMILIES,
  ...TERMINAL_BUNDLED_NERD_FONT_FAMILIES,
  "monospace",
]);
export const TERMINAL_PADDING_X_PX = 2;
export const TERMINAL_PADDING_BOTTOM_PX = 2;
export const TERMINAL_PADDING_TOP_PX = 4;
export const TERMINAL_OSC_QUERY_SEQUENCE_START = "\u001b]";
export const TERMINAL_OSC_STRING_TERMINATOR = "\u001b\\";
export const TERMINAL_OSC_BELL_TERMINATOR = "\u0007";
export const TERMINAL_OSC_C1_TERMINATOR = "\u009c";
export const MAX_PENDING_OSC_COLOR_QUERY_BYTES = 4 * 1024;
export const TERMINAL_MOUSE_BUTTON_MODE = 1000;
export const TERMINAL_MOUSE_DRAG_MODE = 1002;
export const TERMINAL_MOUSE_ANY_MOTION_MODE = 1003;
export const TERMINAL_MOUSE_SGR_MODE = 1006;
export const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
} as const;

export const TERMINAL_ANSI_PALETTE = [
  TERMINAL_THEME.black,
  TERMINAL_THEME.red,
  TERMINAL_THEME.green,
  TERMINAL_THEME.yellow,
  TERMINAL_THEME.blue,
  TERMINAL_THEME.magenta,
  TERMINAL_THEME.cyan,
  TERMINAL_THEME.white,
  TERMINAL_THEME.brightBlack,
  TERMINAL_THEME.brightRed,
  TERMINAL_THEME.brightGreen,
  TERMINAL_THEME.brightYellow,
  TERMINAL_THEME.brightBlue,
  TERMINAL_THEME.brightMagenta,
  TERMINAL_THEME.brightCyan,
  TERMINAL_THEME.brightWhite,
] as const;

let ghosttyInitPromise: Promise<void> | null = null;

export function initializeGhosttyWeb(): Promise<void> {
  if (!ghosttyInitPromise) {
    ghosttyInitPromise = init().catch((error) => {
      ghosttyInitPromise = null;
      throw error;
    });
  }

  return ghosttyInitPromise;
}

export async function resolveTerminalFontFamily() {
  if (typeof document === "undefined" || !("fonts" in document)) {
    return TERMINAL_FONT_FAMILY;
  }

  await Promise.allSettled(
    [...TERMINAL_TEXT_FONT_FAMILIES, ...TERMINAL_SYMBOL_FONT_FAMILIES, ...TERMINAL_BUNDLED_NERD_FONT_FAMILIES].map((fontFamily) =>
      document.fonts.load(
        `${TERMINAL_FONT_SIZE_PX}px ${buildTerminalFontFamily([fontFamily])}`,
        TERMINAL_GLYPH_SAMPLE,
      ),
    ),
  );
  await document.fonts.ready;

  const availableFonts = [...TERMINAL_TEXT_FONT_FAMILIES, ...TERMINAL_SYMBOL_FONT_FAMILIES, ...TERMINAL_BUNDLED_NERD_FONT_FAMILIES]
    .filter((fontFamily) =>
      document.fonts.check(
        `${TERMINAL_FONT_SIZE_PX}px ${buildTerminalFontFamily([fontFamily])}`,
        TERMINAL_GLYPH_SAMPLE,
      )
    );

  return buildTerminalFontFamily([
    ...availableFonts,
    "monospace",
  ]);
}

export async function remeasureTerminalFont(terminal: Terminal, fitAddon: FitAddon | null) {
  if (typeof document === "undefined" || !("fonts" in document) || !terminal.renderer || !terminal.wasmTerm) {
    return;
  }

  await document.fonts.ready;
  terminal.renderer.remeasureFont();

  const nextDimensions = fitAddon?.proposeDimensions();
  if (
    nextDimensions &&
    (nextDimensions.cols !== terminal.cols || nextDimensions.rows !== terminal.rows)
  ) {
    terminal.resize(nextDimensions.cols, nextDimensions.rows);
    return;
  }

  terminal.renderer.resize(terminal.cols, terminal.rows);
  terminal.renderer.render(terminal.wasmTerm, true, terminal.getViewportY());
}
