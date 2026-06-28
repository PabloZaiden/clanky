/**
 * Main binary entrypoint for the Clanky CLI.
 */

import { runMain } from "./cli/runtime";

try {
  const exitCode = await runMain(Bun.argv.slice(2));
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
} catch (error) {
  console.error(`Fatal error: ${String(error)}`);
  process.exit(1);
}
