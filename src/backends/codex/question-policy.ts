/**
 * Per-thread question policy, including Codex's independently registered async tool.
 */

import { join } from "node:path";
import type { HarnessQuestionPolicy } from "@/shared/harness-control";
import type { ThreadStartParams } from "./generated";
import type { CodexRuntime } from "./runtime";
import { HarnessError } from "../harness-errors";

export async function codexQuestionConfig(
  runtime: CodexRuntime,
  policy: HarnessQuestionPolicy | undefined,
): Promise<ThreadStartParams["config"]> {
  const config: NonNullable<ThreadStartParams["config"]> = {
    "tools.experimental_request_user_input.enabled": policy === "interactive",
    "features.default_mode_request_user_input": policy === "interactive",
  };
  if (policy === "interactive") return config;
  const [current, managed] = await Promise.all([
    runtime.rpc.request("config/read", { includeLayers: false, cwd: runtime.directory }),
    runtime.rpc.request("configRequirements/read", undefined),
  ]);
  const features = current.config["features"];
  const hooks = features && typeof features === "object" && !Array.isArray(features) ? features["hooks"] : undefined;
  if (hooks === false || (hooks && typeof hooks === "object" && !Array.isArray(hooks) && hooks["enabled"] === false)
    || managed.requirements?.featureRequirements?.["hooks"] === false || managed.requirements?.allowManagedHooksOnly) {
    throw new HarnessError("harness_unsupported_feature", "Autonomous Codex sessions require enabled hooks and permission to use a session-owned question policy.");
  }
  const matcher = "^(request_user_input|request_user_input_async|send_user_message_async)$";
  const output = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny",
      permissionDecisionReason: "Human questions are disabled for this autonomous session. Continue autonomously or report missing information.",
    },
  });
  const command = `printf '%s\\n' '${output}'`;
  const windowsOutput = Buffer.from(`[Console]::WriteLine('${output}')`, "utf16le").toString("base64");
  const commandWindows = `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${windowsOutput}`;
  const handler = { type: "command", command, commandWindows, timeout: 10, async: false };
  // Codex trusts a normalized, alphabetically ordered identity, not the source text.
  const identity = {
    event_name: "pre_tool_use",
    hooks: [{ async: false, command: process.platform === "win32" ? commandWindows : command, timeout: 10, type: "command" }],
    matcher,
  };
  const trustedHash = `sha256:${new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex")}`;
  const source = join(process.platform === "win32" ? "C:\\" : "/", "<session-flags>", "config.toml");
  config["hooks"] = {
    PreToolUse: [{ matcher, hooks: [handler] }],
    state: { [`${source}:pre_tool_use:0:0`]: { enabled: true, trusted_hash: trustedHash } },
  };
  return config;
}
