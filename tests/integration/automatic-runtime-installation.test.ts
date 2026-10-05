/**
 * Private runtime installation and durable startup assets at the CLI boundary.
 */
import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutorImpl } from "../../src/core/remote-command-executor";
import { getWorkerPaths } from "../../src/core/provisioning/worker-assets";
import { prepareWorkerRuntimeAssets } from "../../src/core/provisioning/worker-runtime-assets";

// This lower boundary protects real shell installation, atomic publication and
// cleanup. HTTP provisioning uses a Devbox double and cannot prove these effects.
test.skipIf(process.platform === "win32")("automatic runtimes install privately, survive offline startup and retain selection on installation failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-automatic-runtime-"));
  const tools = join(directory, "tools");
  const failure = join(directory, "registry-offline");
  const paths = getWorkerPaths(directory, directory);
  await mkdir(tools);
  await mkdir(paths.hostRoot, { recursive: true });
  await Bun.write(join(tools, "npm"), `#!${process.execPath}
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
if (!prefix) throw new Error("Expected workspace-local npm prefix");
const spec = process.argv.at(-1);
const packages = {
  "@github/copilot@1.0.91": ["@github/copilot", "1.0.91", "copilot"],
  "@openai/codex@0.159.2": ["@openai/codex", "0.159.2", "codex"],
  "@opencode/cli@2.0.20": ["@opencode/cli", "2.0.20", "opencode"],
};
if (await Bun.file(${JSON.stringify(failure)}).exists()) {
  await Bun.write(join(prefix, "partial-download"), "incomplete");
  process.exit(42);
}
const selection = packages[spec];
if (!selection) throw new Error("Unexpected CLI package");
const [name, version, executable] = selection;
const reportedVersion = executable === "opencode" ? "opencode v" + version : version;
await mkdir(join(prefix, "node_modules", name), { recursive: true });
await mkdir(join(prefix, "node_modules", ".bin"), { recursive: true });
await Bun.write(join(prefix, "node_modules", name, "package.json"), JSON.stringify({ version }));
const binary = join(prefix, "node_modules", ".bin", executable);
await Bun.write(binary, "#!/bin/sh\\necho " + reportedVersion + "\\n");
await chmod(binary, 0o755);
`);
  await chmod(join(tools, "npm"), 0o755);
  await Bun.write(join(tools, "copilot"), "#!/bin/sh\necho system-copilot\n");
  await chmod(join(tools, "copilot"), 0o755);
  const previousPath = process.env["PATH"];
  process.env["PATH"] = `${tools}:${previousPath}`;
  const executor = new CommandExecutorImpl({ directory });
  const privateCommand = async (executable: string) => await executor.exec(join(paths.containerRoot, "runtime", "bin", executable), ["--version"]);
  try {
    const installed = await prepareWorkerRuntimeAssets(executor, { paths, runtime: { adapter: "copilot", provider: "copilot" }, install: true });
    expect((await privateCommand("copilot")).stdout.trim()).toBe("1.0.91");
    expect((await executor.exec(join(tools, "copilot"), ["--version"])).stdout.trim()).toBe("system-copilot");
    // Selected-only installation is an explicit scope/data-safety contract.
    expect(await Bun.file(join(paths.containerRoot, "runtime", "bin", "codex")).exists()).toBe(false);
    await Bun.write(failure, "offline");
    expect((await executor.exec("sh", [join(paths.hostRoot, "install-runtime.sh")])).success).toBe(true);
    expect((await privateCommand("copilot")).success).toBe(true);

    let installError: unknown;
    try {
      await prepareWorkerRuntimeAssets(executor, { paths, runtime: { adapter: "codex", provider: "codex" }, install: true });
    } catch (error) { installError = error; }
    expect(installError).toMatchObject({ code: "workspace_runtime_install_failed" });
    expect(await Bun.file(join(paths.hostRoot, "runtime.json")).json()).toEqual({ adapter: "copilot", provider: "copilot" });
    expect((await privateCommand("copilot")).success).toBe(true);
    expect((await readdir(join(paths.hostRoot, "runtime"))).filter((name) => name.startsWith(".install-"))).toEqual([]);
    expect((await readdir(paths.hostRoot)).filter((name) => name.includes(".pending-"))).toEqual([]);

    await rm(failure);
    await prepareWorkerRuntimeAssets(executor, { paths, runtime: { adapter: "codex", provider: "codex" }, install: true });
    expect((await privateCommand("codex")).stdout.trim()).toBe("0.159.2");
    await prepareWorkerRuntimeAssets(executor, { paths, runtime: { adapter: "opencode2", provider: "opencode" }, install: true });
    expect((await privateCommand("opencode2")).stdout.trim()).toContain("2.0.20");
    await installed.rollback();
    expect(await Bun.file(join(paths.hostRoot, "runtime.json")).exists()).toBe(false);
  } finally {
    if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
