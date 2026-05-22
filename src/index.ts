/**
 * Main binary entrypoint for the standalone Clanky server.
 */

import { startServer } from "./server";

try {
  await startServer();
} catch (error) {
  console.error(`Fatal error during startup: ${String(error)}`);
  process.exit(1);
}
