/**
 * Main binary entrypoint for the Ralpher server and CLI.
 */

import { runMain } from "./entrypoint";

try {
  const exitCode = await runMain(Bun.argv.slice(2));
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
} catch (error) {
  console.error(`Fatal error during startup: ${String(error)}`);
  process.exit(1);
}
