/**
 * Build/dev-only projection of the real route definitions into public data.
 */

import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLIENT_OPERATION_CATALOG_PATH = "/webapp-assets/collaboration-operations.json";
export const CLIENT_OPERATION_CATALOG_FILE = fileURLToPath(new URL("../.cache/collaboration-operations.json", import.meta.url));

export async function writeClientOperationCatalog(options: { isolated?: boolean; outputFile?: string } = {}): Promise<void> {
  if (options.isolated) {
    const home = await mkdtemp(join(tmpdir(), "clanky-client-catalog-"));
    try {
      const child = Bun.spawnSync([process.execPath, "--no-env-file", import.meta.filename, options.outputFile ?? CLIENT_OPERATION_CATALOG_FILE], {
        env: {
          HOME: home, CLANKY_DATA_DIR: join(home, "data"), NODE_ENV: "production",
          ...(process.env["PATH"] ? { PATH: process.env["PATH"] } : {}),
          XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "share"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        // Cold route projection is build work, not a request-time operation.
        timeout: 30_000, maxBuffer: 64 * 1_024,
        stdout: "pipe", stderr: "pipe",
      });
      if (child.exitCode !== 0) {
        throw new Error(`Operation catalog generation failed (${child.signalCode ?? child.exitCode}): ${child.stderr.toString()}`);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const { nativeApiRoutes } = await import("./api");
  const { projectCollaborationOperations } = await import("./api/collaboration-operation-metadata");
  const { CollaborationOperationCatalogSchema } = await import("./contracts/schemas/collaboration-operation");
  const operations = CollaborationOperationCatalogSchema.parse(projectCollaborationOperations(nativeApiRoutes));
  await Bun.write(options.outputFile ?? CLIENT_OPERATION_CATALOG_FILE, JSON.stringify(operations));
}

if (import.meta.main) await writeClientOperationCatalog({ outputFile: process.argv[2] });
