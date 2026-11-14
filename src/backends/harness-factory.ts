/**
 * Local harness construction, independent of workspace and host routing.
 */

import type { HarnessAdapter } from "@/shared/settings";
import type { Backend } from "./types";
import { CopilotBackend } from "./copilot";
import { CodexBackend } from "./codex";
import { OpenCodeBackend } from "./opencode2";

export function createLocalHarnessBackend(
  adapter: HarnessAdapter,
): Backend {
  switch (adapter) {
    case "copilot": return new CopilotBackend();
    case "codex": return new CodexBackend();
    case "opencode2": return new OpenCodeBackend();
  }
}
