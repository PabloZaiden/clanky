const SINGLE_LINE_ROWS = 1 as const;
const MULTILINE_ROWS = 2 as const;
const SINGLE_LINE_MIN_HEIGHT_CLASS = "min-h-9" as const;
const MULTILINE_MIN_HEIGHT_CLASS = "min-h-[58px]" as const;
const SINGLE_LINE_PADDING_CLASS = "py-1.5" as const;
const MULTILINE_PADDING_CLASS = "py-2" as const;

export type ComposerRows = typeof SINGLE_LINE_ROWS | typeof MULTILINE_ROWS;
export type ComposerMinHeightClass =
  | typeof SINGLE_LINE_MIN_HEIGHT_CLASS
  | typeof MULTILINE_MIN_HEIGHT_CLASS;
export type ComposerPaddingClass =
  | typeof SINGLE_LINE_PADDING_CLASS
  | typeof MULTILINE_PADDING_CLASS;

export function getComposerRows(value: string): ComposerRows {
  return value.includes("\n") || value.includes("\r") ? MULTILINE_ROWS : SINGLE_LINE_ROWS;
}

export function getComposerMinHeightClass(rows: ComposerRows): ComposerMinHeightClass {
  return rows === MULTILINE_ROWS ? MULTILINE_MIN_HEIGHT_CLASS : SINGLE_LINE_MIN_HEIGHT_CLASS;
}

export function getComposerPaddingClass(rows: ComposerRows): ComposerPaddingClass {
  return rows === MULTILINE_ROWS ? MULTILINE_PADDING_CLASS : SINGLE_LINE_PADDING_CLASS;
}
