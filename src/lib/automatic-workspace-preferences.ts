export function getAutomaticWorkspaceRepositoryPrefix(
  githubUsername: string | null | undefined,
): string {
  const normalizedUsername = githubUsername?.trim() ?? "";
  return normalizedUsername ? `https://github.com/${normalizedUsername}/` : "";
}
