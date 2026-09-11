/**
 * Repository URL validation shared by the automatic workspace form and API contracts.
 */

const GITHUB_SSH_PREFIX = /^git@github\.com:/i;

export function isIncompleteGitHubRepositoryUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!GITHUB_SSH_PREFIX.test(trimmed)) {
    return false;
  }

  const repositoryPath = trimmed
    .replace(GITHUB_SSH_PREFIX, "")
    .replace(/\/+$/, "");
  return !repositoryPath.includes("/");
}
