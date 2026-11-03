/**
 * Installs the deterministic ACP fixture as a normal provider executable.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const PROVIDER_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "acp.ts");
const CODEX_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "codex.ts");
const COPILOT_NATIVE_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "copilot-native.ts");
const OPENCODE_NATIVE_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "opencode-native.ts");
const GITHUB_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "github.ts");

export async function installExternalCodexProvider(binDirectory: string): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const executable = process.execPath;
  const wrapperPath = join(binDirectory, "codex");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    wrapperPath,
    `#!/bin/sh\nexec ${quote(executable)} ${quote(CODEX_PATH)} "$@"\n`,
  );
  await chmod(wrapperPath, 0o700);
}

export async function installExternalAcpProvider(binDirectory: string): Promise<void> {
  await installProviderExecutable(binDirectory, "copilot", PROVIDER_PATH);
}

export async function installExternalNativeCopilotProvider(binDirectory: string): Promise<void> {
  await installProviderExecutable(binDirectory, "copilot", COPILOT_NATIVE_PATH);
}

export async function installExternalNativeOpenCodeProvider(binDirectory: string): Promise<void> {
  await installProviderExecutable(binDirectory, "opencode2", OPENCODE_NATIVE_PATH);
}

async function installProviderExecutable(binDirectory: string, name: string, providerPath: string): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const executable = process.execPath;
  const wrapperPath = join(binDirectory, name);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    wrapperPath,
    `#!/bin/sh\nexec ${quote(executable)} ${quote(providerPath)} "$@"\n`,
  );
  await chmod(wrapperPath, 0o700);
}

export async function installExternalGitHubProvider(
  binDirectory: string,
): Promise<void> {
  await installProviderExecutable(binDirectory, "gh", GITHUB_PATH);
}
