import { expect, test } from "bun:test";
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { currentEnvironment, requireCommand } from "./support/process";

test("a host creates, enters and recovers its non-root project environment without a worker connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-environment-"));
  const source = join(directory, "project");
  const binary = resolve(import.meta.dir, "../../dist/clanky");
  const env = currentEnvironment({ HOME: join(directory, "home"), CLANKY_DATA_DIR: join(directory, "data") });
  const cli = async (...args: string[]) => await requireCommand(
    [binary, "environment", ...args], { cwd: source, env, timeoutMs: 120_000 },
  );
  const definition = JSON.stringify({
    image: "mcr.microsoft.com/devcontainers/base:noble",
    remoteUser: "vscode",
    postCreateCommand: "printf preserved > /var/lib/clanky/project-hook",
  });
  await Promise.all([mkdir(join(source, ".devcontainer"), { recursive: true }), mkdir(env["HOME"]!, { mode: 0o700 })]);
  if (process.getuid?.() === 0) await chown(source, 1000, 1000);
  try {
    await writeFile(join(source, ".devcontainer", "devcontainer.json"), definition);
    await cli("up", "--startup-command", "id -u >> /var/lib/clanky/starts");
    const initial = JSON.parse((await cli("status")).stdout);
    expect(initial.running).toBe(true);
    const output = await cli("exec", "--", "sh", "-c",
      'test "$(id -u)" -ne 0 && test -w . && test "$(stat -c %a /var/lib/clanky/.)" = 700 && printf retained > "$CODEX_HOME/acceptance-profile" && cat /var/lib/clanky/project-hook');
    expect(output.stdout).toBe("preserved");
    await cli("stop");
    expect(JSON.parse((await cli("status")).stdout).running).toBe(false);
    await cli("arise");
    const recovered = JSON.parse((await cli("status")).stdout);
    expect(recovered.containerId).toBe(initial.containerId);
    const starts = await cli("shell", "--", "cat", "/var/lib/clanky/starts");
    expect(starts.stdout.trim().split("\n")).toHaveLength(2);
    await cli("rebuild");
    const rebuilt = JSON.parse((await cli("status")).stdout);
    expect(rebuilt.containerId).not.toBe(initial.containerId);
    await cli("restart");
    expect(JSON.parse((await cli("status")).stdout).containerId).toBe(rebuilt.containerId);
    expect((await cli("exec", "--", "cat", "/var/lib/clanky/starts")).stdout.trim().split("\n")).toHaveLength(4);
    expect((await cli("exec", "--", "sh", "-c", 'cat "$CODEX_HOME/acceptance-profile"')).stdout).toBe("retained");
    expect(await readFile(join(source, ".devcontainer", "devcontainer.json"), "utf8")).toBe(definition);
  } finally {
    try { await cli("remove", "--reset-credentials"); }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
}, 120_000);
