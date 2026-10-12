/**
 * Transport-neutral filesystem tree records.
 */

export interface FileSystemTreeEntry {
  /** Relative to the requested root, using the execution host's path semantics. */
  path: string;
  kind: "file" | "directory";
  isSymbolicLink: boolean;
}
