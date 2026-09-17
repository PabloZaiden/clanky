/**
 * Main binary entrypoint for the Clanky CLI.
 */

import "reflect-metadata";
import { isEmbeddedMockAcpInvocation } from "./backends/acp/mock-acp-command";
import { runMockAcpServer } from "./backends/acp/mock-acp-server";
import { createClankyCli } from "./cli";

try {
  if (isEmbeddedMockAcpInvocation()) {
    await runMockAcpServer();
  } else {
    process.exitCode = await createClankyCli().run();
  }
} catch (error) {
  console.error(`Fatal error: ${String(error)}`);
  process.exitCode = 1;
}
