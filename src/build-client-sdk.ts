/**
 * Emit a self-contained browser SDK distribution and its real operation catalog.
 */

import { writeClientOperationCatalog } from "./client-operation-catalog";

const result = await Bun.build({
  entrypoints: ["src/client-sdk/collaboration/index.ts"],
  target: "browser", format: "esm", minify: true, outdir: "dist/client-sdk",
});
if (!result.success) throw new AggregateError(result.logs, "Browser client SDK build failed.");
await writeClientOperationCatalog({
  isolated: true, outputFile: "dist/client-sdk/collaboration-operations.json",
});
