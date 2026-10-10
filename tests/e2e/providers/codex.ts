/**
 * Deterministic external Codex provider used by black-box E2E scenarios.
 */

import { serveCodexAppServer } from "./codex-app-server";

const homeDirectory = process.env["HOME"];

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.160.1\n");
} else if (!homeDirectory) {
  throw new Error("The E2E Codex fixture requires an isolated HOME directory.");
} else {
  await serveCodexAppServer(homeDirectory);
}
