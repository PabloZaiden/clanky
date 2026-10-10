/**
 * Main binary entrypoint for the Clanky CLI.
 */

import "reflect-metadata";
import { createClankyCli } from "./cli";

try {
  process.exitCode = await createClankyCli().run();
} catch (error) {
  console.error(`Fatal error: ${String(error)}`);
  process.exitCode = 1;
}
