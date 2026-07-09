export interface DictationInsertion {
  value: string;
  caretPosition: number;
}

function needsLeadingSpace(before: string, text: string): boolean {
  return before.length > 0 && !/\s$/.test(before) && !/^[\s.,!?;:)]/.test(text);
}

function needsTrailingSpace(after: string, text: string): boolean {
  return after.length > 0 && !/^\s/.test(after) && !/[\s([{]$/.test(text);
}

export function insertDictationText(
  value: string,
  transcript: string,
  selectionStart?: number,
  selectionEnd?: number,
): DictationInsertion {
  const text = transcript.trim();
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = needsLeadingSpace(before, text) ? " " : "";
  const suffix = needsTrailingSpace(after, text) ? " " : "";
  const insertedText = `${prefix}${text}${suffix}`;

  return {
    value: `${before}${insertedText}${after}`,
    caretPosition: before.length + prefix.length + text.length,
  };
}
