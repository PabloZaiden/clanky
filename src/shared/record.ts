/**
 * Safe access to declared fields in structured transport data.
 */

export function isReadRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readReferenceField(value: unknown, name: string): unknown {
  let current = value;
  for (const part of name.split(".")) {
    if (!isReadRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}
