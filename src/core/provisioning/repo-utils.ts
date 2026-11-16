import { DomainError } from "../../domain/domain-error";

export function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
}

export function extractRepoName(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("Repository URL is required");
  }

  let pathValue = trimmed;
  if (trimmed.includes("://")) {
    try {
      pathValue = new URL(trimmed).pathname;
    } catch (error) {
      throw new DomainError("invalid_repository_url", "The repository URL is invalid.", {
        cause: error,
      });
    }
  } else {
    const scpLikeMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
    if (scpLikeMatch?.[1]) {
      pathValue = scpLikeMatch[1];
    }
  }

  const segments = pathValue.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1]?.replace(/\.git$/i, "");
  if (!lastSegment) {
    throw new Error(`Could not derive repository name from URL: ${url}`);
  }

  return lastSegment;
}
