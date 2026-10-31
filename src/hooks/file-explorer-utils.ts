import type { WorkspaceFileNode } from "@/shared";

export function getParentDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash >= 0 ? path.slice(0, lastSlash) : "";
}

export function getAncestorDirectories(path: string): string[] {
  const directories: string[] = [];
  let currentDirectory = getParentDirectory(path);
  while (currentDirectory) {
    directories.unshift(currentDirectory);
    currentDirectory = getParentDirectory(currentDirectory);
  }
  return directories;
}

export function isPathWithinOrEqual(path: string, ancestorPath: string): boolean {
  return path === ancestorPath || path.startsWith(`${ancestorPath}/`);
}

export function upsertDirectoryEntry(
  directoryEntries: Record<string, WorkspaceFileNode[]>,
  entry: WorkspaceFileNode,
): Record<string, WorkspaceFileNode[]> {
  const parentDirectory = getParentDirectory(entry.path);
  const currentEntries = directoryEntries[parentDirectory] ?? [];
  const nextEntries = currentEntries.some((currentEntry) => currentEntry.path === entry.path)
    ? currentEntries.map((currentEntry) => currentEntry.path === entry.path ? entry : currentEntry)
    : [...currentEntries, entry];

  return {
    ...directoryEntries,
    [parentDirectory]: nextEntries.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    }),
  };
}

export function findDirectoryNode(
  directoryEntries: Record<string, WorkspaceFileNode[]>,
  path: string,
): WorkspaceFileNode | null {
  const parentDirectory = getParentDirectory(path);
  return directoryEntries[parentDirectory]?.find((entry) => entry.path === path) ?? null;
}

export function isWithinLazySubtree(path: string, lazySubtreeRoots: string[]): boolean {
  return lazySubtreeRoots.some((rootPath) => path === rootPath || path.startsWith(`${rootPath}/`));
}

export function getExpandedDirectoriesForTreeResponse(
  expandedDirectories: string[],
  entriesByDirectory: Record<string, WorkspaceFileNode[]>,
): string[] {
  return expandedDirectories.filter((expandedPath) =>
    Object.prototype.hasOwnProperty.call(entriesByDirectory, expandedPath)
  );
}
