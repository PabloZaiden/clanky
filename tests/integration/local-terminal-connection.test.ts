import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPersistentSessionDeleteCommand,
} from "../../src/core/ssh-persistent-session";
import { LocalTerminalConnection } from "../../src/core/terminal/local-terminal-connection";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { pollUntil } from "../helpers/polling";

type LocalTerminalMode = "direct" | "dtach";

async function commandExists(command: string): Promise<boolean> {
  const result = await Bun.$`which ${command}`.quiet().nothrow();
  return result.exitCode === 0;
}

describe("LocalTerminalConnection integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clanky-local-terminal-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  for (const mode of ["direct", "dtach"] as const satisfies readonly LocalTerminalMode[]) {
    test(`resizes the attached shell in ${mode} mode`, async () => {
      if (mode === "dtach" && !(await commandExists("dtach"))) {
        return;
      }

      const sessionId = crypto.randomUUID();
      const remoteSessionName = `clanky-test-${sessionId}`;
      const executor = new TestCommandExecutor();
      const output: string[] = [];
      const connection = new LocalTerminalConnection({
        sessionId,
        remoteSessionName,
        directory: tempDir,
        connectionMode: mode,
        useTmux: false,
        executor,
        callbacks: {
          onOutput: (chunk) => output.push(chunk),
        },
      });

      try {
        const result = await connection.connect();
        expect(result.runtimeConnectionMode).toBe(mode);

        await connection.resize(120, 32);
        connection.sendInput(
          "size=$(stty size); printf 'LOCAL_TERMINAL_SIZE:%s:DONE\\n' \"$size\"\n",
        );

        await pollUntil(
          () => output.join(""),
          (value) => value.includes("LOCAL_TERMINAL_SIZE:32 120:DONE"),
          {
            description: `${mode} terminal resize output`,
            timeoutMs: 10_000,
          },
        );
      } finally {
        await connection.dispose();
        if (mode === "dtach") {
          const cleanup = await executor.exec(
            "bash",
            [
              "-lc",
              buildPersistentSessionDeleteCommand({
                config: {
                  id: sessionId,
                  remoteSessionName,
                },
              }),
            ],
            { cwd: tempDir },
          );
          if (!cleanup.success) {
            throw new Error(
              cleanup.stderr.trim()
              || cleanup.stdout.trim()
              || "Failed to clean up the persistent terminal session.",
            );
          }
        }
      }
    });
  }
});
