import type { Workspace } from "@/shared/workspace";

function normalizeAbsolutePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      return null;
    }
    parts.push(part);
  }

  return `/${parts.join("/")}`;
}

export function isSafeProvisionedDirectory(sourceDirectory: string, basePath: string): boolean {
  const normalizedSource = normalizeAbsolutePath(sourceDirectory);
  const normalizedBase = normalizeAbsolutePath(basePath);
  if (!normalizedSource || !normalizedBase) {
    return false;
  }
  if (normalizedSource === "/" || normalizedBase === "/" || normalizedSource === normalizedBase) {
    return false;
  }
  if (!normalizedSource.startsWith(`${normalizedBase.replace(/\/+$/, "")}/`)) {
    return false;
  }
  return normalizedSource.split("/").filter(Boolean).length >= 2;
}

export function isAutoProvisionedWorkspace(workspace: Workspace): boolean {
  const sourceDirectory = workspace.sourceDirectory?.trim();
  const basePath = workspace.basePath?.trim();
  return Boolean(
    sourceDirectory
      && workspace.sshServerId?.trim()
      && basePath
      && isSafeProvisionedDirectory(sourceDirectory, basePath),
  );
}
