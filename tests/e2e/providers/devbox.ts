#!/usr/bin/env bun

/**
 * Deterministic external Devbox boundary for provisioning E2E scenarios.
 */

import { join } from "node:path";

const args = process.argv.slice(2);
const cwd = process.cwd();
const runningMarker = join(cwd, ".e2e-devbox-running");
const slowMarker = join(cwd, ".e2e-devbox-slow");
const failMarker = join(cwd, ".e2e-devbox-fail");

async function waitForCancellation(): Promise<void> {
  process.stdout.write("devbox fixture waiting for cancellation\n");
  await new Promise<void>((resolve) => {
    process.once("SIGHUP", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  process.exitCode = 130;
}

if (args[0] === "--help") {
  process.stdout.write("Deterministic Devbox E2E fixture\n");
} else if (args[0] === "up" || args[0] === "rebuild") {
  if (await Bun.file(failMarker).exists()) {
    process.stderr.write("devbox fixture failure requested\n");
    process.exitCode = 2;
  } else if (await Bun.file(slowMarker).exists()) {
    await waitForCancellation();
  } else {
    await Bun.write(runningMarker, `${args[0]}\n`);
    process.stdout.write(`devbox fixture ${args[0]} complete\n`);
  }
} else if (args[0] === "status") {
  const port = Number.parseInt(process.env["CLANKY_E2E_SSH_PORT"] ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write("CLANKY_E2E_SSH_PORT is invalid\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${JSON.stringify({
      running: await Bun.file(runningMarker).exists(),
      ports: [port],
      sshEnabled: true,
      password: null,
      workdir: cwd,
      sshUser: process.env["USER"] ?? null,
      sshPort: port,
      remoteUser: process.env["USER"] ?? null,
      hasCredentialFile: false,
      credentialPath: "",
      publishedPorts: {},
    })}\n`);
  }
} else if (args[0] === "arise") {
  process.stdout.write("devbox fixture arise complete\n");
} else {
  process.stderr.write(`Unsupported devbox fixture command: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
