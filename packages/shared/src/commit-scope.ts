/**
 * Helpers for normalizing commit scopes.
 */

const GENERIC_COMMIT_SCOPES = new Set([
  "ralph",
]);

/**
 * Returns a meaningful commit scope, or `undefined` when the scope should be omitted.
 *
 * Generic project-wide placeholders such as `ralph` are treated the same as no scope.
 */
export function normalizeCommitScope(scope: string | null | undefined): string | undefined {
  const trimmedScope = scope?.trim();
  if (!trimmedScope) {
    return undefined;
  }

  if (GENERIC_COMMIT_SCOPES.has(trimmedScope.toLowerCase())) {
    return undefined;
  }

  return trimmedScope;
}
