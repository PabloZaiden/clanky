/**
 * Shared naming rules for generated workspace chat names.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildGeneratedChatName(projectName: string, nextSuffix: number): string {
  const suffix = ` - ${nextSuffix}`;
  const fallbackPrefix = "Chat";
  const trimmedProjectName = projectName.trim() || fallbackPrefix;
  const maxPrefixLength = Math.max(1, 100 - suffix.length);
  return `${trimmedProjectName.slice(0, maxPrefixLength).trim() || fallbackPrefix}${suffix}`;
}

export function isGeneratedChatName(name: string, workspaceName: string): boolean {
  const trimmedName = name.trim();
  const suffixMatch = trimmedName.match(/ - \d+$/);
  if (!suffixMatch) {
    return false;
  }

  const suffix = suffixMatch[0];
  const maxPrefixLength = Math.max(1, 100 - suffix.length);
  const prefix = (workspaceName.trim() || "Chat").slice(0, maxPrefixLength).trim() || "Chat";
  const generatedPattern = new RegExp(`^${escapeRegExp(prefix)} - \\d+$`);
  return generatedPattern.test(trimmedName);
}
