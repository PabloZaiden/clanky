const POSITIVE_INTEGER_PATTERN = /^[0-9]+$/;

export function parsePositiveIssueNumber(value: string): number | undefined {
  const trimmedValue = value.trim();
  if (!POSITIVE_INTEGER_PATTERN.test(trimmedValue)) {
    return undefined;
  }

  const parsedValue = Number(trimmedValue);
  return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : undefined;
}
