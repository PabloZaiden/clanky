import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildPersistentSessionDeleteCommand,
} from "../../src/core/ssh-persistent-session";
import { LocalTerminalConnection } from "../../src/core/terminal/local-terminal-connection";
import { CommandExecutorImpl } from "../../src/core/remote-command-executor";
import {
  executionPathsEqual,
  executionPathStyleForPlatform,
} from "../../src/core/execution-path";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { pollUntil } from "../helpers/polling";
import {
  buildTerminalCwdProbe,
  buildTerminalResizeProbe,
} from "../helpers/terminal-resize-probe";

type LocalTerminalMode = "direct" | "dtach";

async function commandExists(command: string): Promise<boolean> {
  return Bun.which(command) !== null;
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
      if (
        process.platform !== "win32"
        && mode === "dtach"
        && !(await commandExists("dtach"))
      ) {
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
        const expectedMode = process.platform === "win32" ? "direct" : mode;
        expect(result.runtimeConnectionMode).toBe(expectedMode);
        if (process.platform === "win32" && mode === "dtach") {
          expect(result.notice).toBeTruthy();
        }

        await connection.resize(120, 32);
        const probe = buildTerminalResizeProbe({
          marker: "LOCAL_TERMINAL_SIZE",
          os: process.platform === "win32"
            ? "windows"
            : process.platform === "darwin"
              ? "darwin"
              : "linux",
          cols: 120,
          rows: 32,
        });
        connection.sendInput(probe.input);

        await pollUntil(
          () => output.join(""),
          (value) => value.includes(probe.expectedOutput),
          {
            description: `${mode} terminal resize output`,
            timeoutMs: 10_000,
          },
        );
      } finally {
        await connection.dispose();
        if (mode === "dtach" && process.platform !== "win32") {
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

  test("resolves a relative local terminal directory exactly once", async () => {
    const originalDirectory = process.cwd();
    const relativeDirectory = "relative-terminal";
    await mkdir(join(tempDir, relativeDirectory));
    const expectedDirectory = await realpath(join(tempDir, relativeDirectory));
    process.chdir(tempDir);
    const executor = new CommandExecutorImpl({
      provider: "local",
      directory: relativeDirectory,
    });
    const output: string[] = [];
    const connection = new LocalTerminalConnection({
      sessionId: crypto.randomUUID(),
      remoteSessionName: `clanky-test-${crypto.randomUUID()}`,
      directory: relativeDirectory,
      connectionMode: "direct",
      useTmux: false,
      executor,
      callbacks: {
        onOutput: (chunk) => output.push(chunk),
      },
      readyTimeoutMs: 1_000,
    });

    try {
      await connection.connect();
      const marker = "LOCAL_TERMINAL_CWD";
      const prefix = `${marker}:`;
      connection.sendInput(buildTerminalCwdProbe({
        marker,
        os: process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "darwin"
            : "linux",
      }));
      await pollUntil(
        () => output.join(""),
        (value) => {
          const start = value.lastIndexOf(prefix);
          const end = value.indexOf(":DONE", start + prefix.length);
          const pathStyle = executionPathStyleForPlatform(process.platform);
          return start >= 0
            && end >= 0
            && pathStyle !== null
            && executionPathsEqual(
              value.slice(start + prefix.length, end),
              expectedDirectory,
              pathStyle,
            );
        },
        {
          description: "relative local terminal working directory",
          timeoutMs: 10_000,
        },
      );
    } finally {
      try {
        await connection.dispose();
      } finally {
        process.chdir(originalDirectory);
      }
    }
  });
});
