const WINDOWS_DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/$/;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:\//;

function normalizeDisplayPath(path: string): string {
  const normalizedSlashes = path.replaceAll("\\", "/");
  const collapsed = normalizedSlashes.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/") && !WINDOWS_DRIVE_ROOT_PATTERN.test(collapsed)) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

function isAbsoluteDisplayPath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_PATH_PATTERN.test(path);
}

export function formatToolPathForDisplay(path: string, displayRoot?: string): string {
  const normalizedPath = normalizeDisplayPath(path);
  if (!displayRoot || !isAbsoluteDisplayPath(normalizedPath)) {
    return normalizedPath;
  }

  const normalizedRoot = normalizeDisplayPath(displayRoot);
  if (!isAbsoluteDisplayPath(normalizedRoot)) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedRoot) {
    return ".";
  }

  const rootedPrefix = normalizedRoot.endsWith("/") ? normalizedRoot : `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(rootedPrefix)) {
    return normalizedPath;
  }

  const relativePath = normalizedPath.slice(rootedPrefix.length);
  return relativePath.length > 0 ? relativePath : normalizedPath;
}
