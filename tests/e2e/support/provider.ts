/**
 * Installs the deterministic ACP fixture as a normal provider executable.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const PROVIDER_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "acp.ts");
const DEVBOX_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "devbox.ts");
const GITHUB_PATH = resolve(ROOT_DIR, "tests", "e2e", "providers", "github.ts");

export async function installExternalAcpProvider(binDirectory: string): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const bundledProviderPath = join(binDirectory, "acp-provider.js");
  const build = await Bun.build({
    entrypoints: [PROVIDER_PATH],
    outdir: binDirectory,
    naming: "acp-provider.js",
    target: "bun",
  });
  if (!build.success) {
    throw new AggregateError(
      build.logs,
      "Failed to bundle the external ACP provider fixture",
    );
  }
  const executable = process.execPath;
  if (process.platform === "win32") {
    await Bun.write(
      join(binDirectory, "copilot.cmd"),
      `@echo off\r\n"${executable}" "${bundledProviderPath}" %*\r\n`,
    );
    return;
  }

  const wrapperPath = join(binDirectory, "copilot");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    wrapperPath,
    `#!/bin/sh\nexec ${quote(executable)} ${quote(bundledProviderPath)} "$@"\n`,
  );
  await chmod(wrapperPath, 0o700);
}

export async function installExternalGitHubProvider(
  binDirectory: string,
): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const executable = process.execPath;
  const statePath = join(binDirectory, "github-state.json");
  if (process.platform === "win32") {
    await Bun.write(
      join(binDirectory, "gh.cmd"),
      `@echo off\r\nset "CLANKY_E2E_GH_STATE_FILE=${statePath}"\r\n"${executable}" "${GITHUB_PATH}" %*\r\n`,
    );
    return;
  }

  const wrapperPath = join(binDirectory, "gh");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    wrapperPath,
    `#!/bin/sh\nCLANKY_E2E_GH_STATE_FILE=${quote(statePath)} exec ${quote(executable)} ${quote(GITHUB_PATH)} "$@"\n`,
  );
  await chmod(wrapperPath, 0o700);
}

export async function installExternalDevboxProvider(
  binDirectory: string,
  sshPort: number,
): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  const executable = process.execPath;
  if (process.platform === "win32") {
    await Bun.write(
      join(binDirectory, "devbox.cmd"),
      `@echo off\r\nset CLANKY_E2E_SSH_PORT=${String(sshPort)}\r\n"${executable}" "${DEVBOX_PATH}" %*\r\n`,
    );
    return;
  }

  const wrapperPath = join(binDirectory, "devbox");
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    wrapperPath,
    `#!/bin/sh\nCLANKY_E2E_SSH_PORT=${String(sshPort)} exec ${quote(executable)} ${quote(DEVBOX_PATH)} "$@"\n`,
  );
  await chmod(wrapperPath, 0o700);
}

export async function installFailingExternalProvider(
  binDirectory: string,
  executableName: string,
): Promise<void> {
  await mkdir(binDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    await Bun.write(
      join(binDirectory, `${executableName}.cmd`),
      "@echo off\r\necho Deterministic provider startup failure 1>&2\r\nexit /b 42\r\n",
    );
    return;
  }

  const wrapperPath = join(binDirectory, executableName);
  await Bun.write(
    wrapperPath,
    "#!/bin/sh\necho 'Deterministic provider startup failure' >&2\nexit 42\n",
  );
  await chmod(wrapperPath, 0o700);
}
