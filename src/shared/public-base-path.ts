/**
 * Shared helpers for deriving and applying the app's public base path.
 */

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z\d+\-.]*:/;

export function normalizePublicBasePath(rawBasePath?: string | null): string {
  const trimmedBasePath = rawBasePath?.trim();
  if (!trimmedBasePath || trimmedBasePath === "/") {
    return "";
  }

  const withLeadingSlash = trimmedBasePath.startsWith("/")
    ? trimmedBasePath
    : `/${trimmedBasePath}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");

  return withoutTrailingSlash === "/" ? "" : withoutTrailingSlash;
}

export function getPublicBasePathFromForwardedPrefix(rawPrefix?: string | null): string {
  return normalizePublicBasePath(rawPrefix);
}

export function getPublicBasePathFromPathname(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "";
  }

  return normalizePublicBasePath(pathname);
}

export function applyPublicBasePath(basePath: string, path: string): string {
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith("//")) {
    return path;
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const normalizedBasePath = normalizePublicBasePath(basePath);

  return normalizedBasePath ? `${normalizedBasePath}${normalizedPath}` : normalizedPath;
}
