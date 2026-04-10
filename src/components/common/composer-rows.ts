const SINGLE_LINE_ROWS = 1 as const;
const MULTILINE_ROWS = 2 as const;

export type ComposerRows = typeof SINGLE_LINE_ROWS | typeof MULTILINE_ROWS;

export function getComposerRows(value: string): ComposerRows {
  return value.split(/\r\n|\r|\n/).length > 1 ? MULTILINE_ROWS : SINGLE_LINE_ROWS;
}
