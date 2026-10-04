/**
 * Backend bootstrap and subprocess cleanup at the external CLI seam.
 * A local protocol executable avoids depending on a live authenticated provider.
 */

import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// This POSIX executable fixture protects configured environment/cwd and reaping,
// which cannot be established through ordinary task HTTP fixtures.
test.skipIf(process.platform === "win32")("native Codex bootstrap honors its configured host environment and reaps the runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-native-bootstrap-"));
  const executable = join(directory, "codex");
  const driver = join(directory, "driver.ts");
  await Bun.write(executable, `#!${process.execPath}
if (process.env["CLANKY_BOOTSTRAP_PROBE"] !== "configured" || process.cwd() !== ${JSON.stringify(directory)}) process.exit(2);
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.159.2");
} else {
  await Bun.write("runtime.pid", String(process.pid));
  let pending = "";
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    let index;
    while ((index = pending.indexOf("\\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      const frame = JSON.parse(line);
      if (frame.id !== undefined) console.log(JSON.stringify({ id: frame.id, result: {} }));
    }
  }
}
`);
  await chmod(executable, 0o700);
  const backendModule = new URL("../../src/backends/codex/codex-backend.ts", import.meta.url).pathname;
  await Bun.write(driver, `
import { CodexBackend } from ${JSON.stringify(backendModule)};
const backend = new CodexBackend();
try {
  await backend.connect({ directory: ${JSON.stringify(directory)}, env: {
    PATH: ${JSON.stringify(directory)},
    CLANKY_BOOTSTRAP_PROBE: "configured",
  } });
  if (!backend.isConnected()) throw new Error("Native connection did not initialize.");
} finally {
  await backend.disconnect();
}
`);
  const child = Bun.spawn([process.execPath, driver], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: join(directory, "no-global-cli"), CLANKY_DATA_DIR: directory },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const pid = Number(await Bun.file(join(directory, "runtime.pid")).text());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    // Absence is the explicit owned-process cleanup contract.
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

// Neutral HTTP doubles cannot prove Codex's official client-ID history recovery.
test.skipIf(process.platform === "win32")("native Codex recovers uncertain input after cold resume without native receipt references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-codex-recovery-"));
  const executable = join(directory, "codex");
  const driver = join(directory, "driver.ts");
  const resultPath = join(directory, "proof.json");
  const fixtureModule = new URL("../fixtures/codex-admission-runtime.ts", import.meta.url).pathname;
  const backendModule = new URL("../../src/backends/codex/codex-backend.ts", import.meta.url).pathname;
  await Bun.write(executable, `#!${process.execPath}\nawait import(${JSON.stringify(fixtureModule)});\n`);
  await chmod(executable, 0o700);
  await Bun.write(driver, `
import { CodexBackend } from ${JSON.stringify(backendModule)};
const config = { directory: ${JSON.stringify(directory)}, env: {
  PATH: ${JSON.stringify(directory)}, CLANKY_CODEX_RECOVERY_FIXTURE: "1",
} };
const inputId = crypto.randomUUID();
const first = new CodexBackend();
let binding;
let initial;
let admission;
let validation;
try {
  await first.connect(config);
  const session = await first.createSession({
    directory: config.directory, ownership: { ownerId: crypto.randomUUID(), contextId: crypto.randomUUID() },
  });
  binding = session.binding;
  initial = await first.harness.reconcileInput(session.id, { inputId });
  await first.sendPromptAsync(session.id, { parts: [{ type: "text", text: "Initial input" }] });
  try {
    const unexpected = await first.harness.steer(session.id, { inputId, prompt: { parts: [{
      type: "resource", resource: { uri: "attachment://document.pdf", mimeType: "application/pdf", blob: "JVBERg==" },
    }] } });
    validation = unexpected;
  } catch (error) {
    validation = { code: error.code };
  }
  admission = await first.harness.steer(session.id, { inputId, prompt: { parts: [{ type: "text", text: "Steered input" }] } });
} finally { await first.disconnect(); }
const resumed = new CodexBackend();
try {
  await resumed.connect(config);
  const session = await resumed.resumeSession(binding);
  const recovery = await resumed.harness.reconcileInput(session.id, { inputId });
  const repeated = await resumed.harness.reconcileInput(session.id, { inputId });
  await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify({ inputId, initial, validation, admission, recovery, repeated }));
} finally { await resumed.disconnect(); }
`);
  const child = Bun.spawn([process.execPath, driver], {
    cwd: process.cwd(),
    env: { ...process.env, CLANKY_DATA_DIR: directory },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, error: exitCode ? stderr : undefined }).toEqual({ exitCode: 0, error: undefined });
    const unknown = z.object({ status: z.literal("unknown"), inputId: z.string() });
    const delivered = z.object({
      status: z.literal("delivered"), inputId: z.string(),
      nativeMessageId: z.string(), nativeClientInputId: z.string(), nativeTurnId: z.string(),
    });
    const proof = z.object({
      inputId: z.string(), initial: unknown,
      validation: z.object({ code: z.literal("harness_unsupported_feature") }),
      admission: unknown,
      recovery: delivered, repeated: delivered,
    }).parse(await Bun.file(resultPath).json());
    const history = z.object({ messages: z.array(z.object({
      turnId: z.string(), item: z.object({ id: z.string(), clientId: z.string() }),
    })) }).parse(await Bun.file(join(directory, "native-history.json")).json());
    expect(history.messages).toHaveLength(1);
    expect(proof.recovery).toEqual({
      status: "delivered", inputId: proof.inputId,
      nativeMessageId: history.messages[0]!.item.id,
      nativeClientInputId: proof.inputId, nativeTurnId: history.messages[0]!.turnId,
    });

    expect(proof.repeated).toEqual(proof.recovery);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

// Neutral activity doubles cannot prove the provider's directory-wide shell
// registry retains foreign writers or that cleanup preserves their OS processes.
test.skipIf(process.platform === "win32")("native OpenCode preserves foreign workspace shells without granting Stop or cleanup ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-opencode-ownership-"));
  const executable = join(directory, "opencode2");
  const driver = join(directory, "driver.ts");
  const fixtureModule = new URL("../fixtures/opencode-shell-runtime.ts", import.meta.url).pathname;
  const backendModule = new URL("../../src/backends/opencode2/opencode-backend.ts", import.meta.url).pathname;
  const safetyModule = new URL("../../src/core/harness-workspace-safety.ts", import.meta.url).pathname;
  await Bun.write(executable, `#!${process.execPath}\nawait import(${JSON.stringify(fixtureModule)});\n`);
  await chmod(executable, 0o700);
  await Bun.write(driver, `
import { OpenCodeBackend } from ${JSON.stringify(backendModule)};
import { getHarnessWorkspaceSafety } from ${JSON.stringify(safetyModule)};
const backend = new OpenCodeBackend();
try {
  await backend.connect({ directory: ${JSON.stringify(directory)}, env: {
    PATH: ${JSON.stringify(directory)}, CLANKY_OPENCODE_SHELL_FIXTURE: "1",
  } });
  const session = await backend.createSession({
    directory: ${JSON.stringify(directory)}, ownership: { ownerId: crypto.randomUUID(), contextId: crypto.randomUUID() },
  });
  const initial = await backend.harness.getActivity(session.id);
  let stopError;
  try { await backend.harness.stopActivity(session.id, "shell:foreign"); }
  catch (error) { stopError = error.code; }
  const cleanup = await backend.harness.settleOwnedWork(session.id);
  const remaining = await backend.harness.getActivity(session.id);
  const pids = await Bun.file(${JSON.stringify(join(directory, "shell-pids.json"))}).json();
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  } };
  const processes = Object.fromEntries(Object.entries(pids).map(([id, pid]) => [id, alive(pid)]));
  await Bun.write(${JSON.stringify(join(directory, "settle-external"))}, "settle");
  const settled = await backend.harness.getActivity(session.id);
  await Bun.write(${JSON.stringify(join(directory, "proof.json"))}, JSON.stringify({
    initial, stopError, cleanup, remaining, processes,
    blocked: getHarnessWorkspaceSafety(remaining), safe: getHarnessWorkspaceSafety(settled),
  }));
} finally { await backend.disconnect(); }
`);
  const child = Bun.spawn([process.execPath, driver], {
    cwd: process.cwd(), env: { ...process.env, CLANKY_DATA_DIR: directory },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ exitCode, error: exitCode ? stderr : undefined }).toEqual({ exitCode: 0, error: undefined });
    const proof = await Bun.file(join(directory, "proof.json")).json();
    expect(proof.initial.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "shell:owned", kind: "process", ownership: "owned" }),
      expect.objectContaining({ id: "shell:foreign", kind: "external", ownership: "unverified", status: "running" }),
      expect.objectContaining({ id: "shell:unattributed", kind: "external", ownership: "unverified", status: "running" }),
    ]));
    expect(proof.stopError).toBe("harness_activity_not_owned");
    expect(proof.cleanup.status).toBe("settled");
    expect(proof.processes).toEqual({ owned: false, foreign: true, unattributed: true });
    expect(proof.blocked).toMatchObject({
      status: "blocked", reason: "active-writers", activityIds: ["shell:foreign", "shell:unattributed"],
    });
    expect(proof.safe.status).toBe("safe");
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});
