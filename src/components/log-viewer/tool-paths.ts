function normalizeDisplayPath(path: string): string {
  const normalizedSlashes = path.replaceAll("\\", "/");
  const collapsed = normalizedSlashes.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) {
    return collapsed.slice(0, -1);
  }
  return collapsed;
}

export function formatToolPathForDisplay(path: string, displayRoot?: string): string {
  const normalizedPath = normalizeDisplayPath(path);
  if (!displayRoot || !normalizedPath.startsWith("/")) {
    return normalizedPath;
  }

  const normalizedRoot = normalizeDisplayPath(displayRoot);
  if (!normalizedRoot.startsWith("/")) {
    return normalizedPath;
  }

  if (normalizedPath === normalizedRoot) {
    return ".";
  }

  const rootedPrefix = `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(rootedPrefix)) {
    return normalizedPath;
  }

  const relativePath = normalizedPath.slice(rootedPrefix.length);
  return relativePath.length > 0 ? relativePath : normalizedPath;
}
