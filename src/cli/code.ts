/**
 * Opens a workspace's existing working directory in a CLI-owned VS Code preview.
 */

import { normalizeBaseUrl } from "@pablozaiden/webapp/cli";
import type { PreviewCommandOptions } from "./preview";

export function parseCodeCommandArgs(args: readonly string[]): PreviewCommandOptions {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  let workspace: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      if (workspace !== undefined) throw new Error("code requires exactly one workspace ID or name");
      workspace = argument;
      continue;
    }
    const separator = argument.indexOf("=");
    const name = separator < 0 ? argument : argument.slice(0, separator);
    if (flags.has(name) || values[name] !== undefined) throw new Error(`${name} may only be specified once`);
    if (name === "--open") {
      if (separator >= 0) throw new Error(`${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!["--chat", "--task", "--base-url"].includes(name)) throw new Error(`Unknown code option: ${name}`);
    const value = separator < 0 ? args[++index] : argument.slice(separator + 1);
    if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} requires a value`);
    values[name] = value.trim();
  }
  if (!workspace?.trim()) throw new Error("code requires a workspace ID or name");
  if (values["--chat"] && values["--task"]) throw new Error("--chat and --task may not be used together");
  return {
    workspace: workspace.trim(),
    port: 0,
    remoteHost: "127.0.0.1",
    host: "127.0.0.1",
    path: "/",
    open: flags.has("--open"),
    ...(values["--base-url"] ? { baseUrl: normalizeBaseUrl(values["--base-url"]) } : {}),
    code: {
      chat: values["--chat"],
      task: values["--task"],
    },
  };
}
