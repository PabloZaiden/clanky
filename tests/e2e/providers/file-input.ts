/**
 * Filesystem tools used by deterministic external agents to inspect user inputs.
 */
import { basename, resolve } from "node:path";

export async function inspectAttachedFiles(
  prompt: string,
  directory: string,
  previousPrompts: readonly string[] = [],
): Promise<string> {
  if (!prompt.includes("Inspect the attached files")) return "";
  const references = new Map<string, string>();
  const directories = new Set<string>();
  for (const text of [...previousPrompts, prompt]) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("{\"name\":") && !line.startsWith("{\"directory\":")) continue;
      const value: unknown = JSON.parse(line);
      if (typeof value === "object" && value !== null && "directory" in value && typeof value.directory === "string") {
        directories.add(value.directory);
      }
      if (typeof value === "object" && value !== null
        && "name" in value && typeof value.name === "string"
        && "path" in value && typeof value.path === "string") {
        references.set(value.path, value.name);
      }
      for (const root of directories) {
        for await (const name of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
          const path = resolve(directory, root, name);
          if (!references.has(path)) references.set(path, basename(path));
        }
      }
    }
  }
  if (!references.size) throw new Error("No attached file references are available to inspect.");
  const records = [];
  for (const [path, name] of references) {
    const bytes = await Bun.file(path).bytes();
    records.push({
      name, path, size: bytes.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
  }
  return `Inspected files: ${JSON.stringify(records)}`;
}
