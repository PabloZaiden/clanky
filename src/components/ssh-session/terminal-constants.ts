import { FitAddon, init, Terminal } from "ghostty-web";

export const TERMINAL_FONT_SIZE_PX = 12;
export const TERMINAL_SCROLLBACK_LINES = 10_000;
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
  background: "#15191f",
  foreground: "#cdd0d7",
  cursor: "#f2f4f8",
  cursorAccent: "#15191f",
  selectionBackground: "#2f3541",
  selectionForeground: "#ffffff",
  black: "#15191f",
  red: "#ff6b6b",
  green: "#8bd49c",
  yellow: "#f4d06f",
  blue: "#7aa2f7",
  magenta: "#c678dd",
  cyan: "#5de4c7",
  white: "#cdd0d7",
  brightBlack: "#5c6370",
  brightRed: "#ff7b72",
  brightGreen: "#9ece6a",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#f2f4f8",
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
