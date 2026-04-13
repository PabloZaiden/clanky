export function normalizeGitHubRepositoryUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  const githubScpMatch = trimmed.match(/^git@github\.com:(.+?)(?:\.git)?\/?$/);
  if (githubScpMatch?.[1]) {
    return `https://github.com/${githubScpMatch[1]}`;
  }

  const sshGithubMatch = trimmed.match(/^ssh:\/\/git@github\.com\/(.+?)(?:\.git)?\/?$/);
  if (sshGithubMatch?.[1]) {
    return `https://github.com/${sshGithubMatch[1]}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== "github.com") {
      return null;
    }

    const normalizedPath = parsed.pathname
      .replace(/\.git$/u, "")
      .replace(/\/+$/u, "");
    if (!normalizedPath || normalizedPath === "/") {
      return null;
    }

    return `https://github.com${normalizedPath}`;
  } catch {
    return null;
  }
}
