import { describe, expect, test } from "bun:test";

import {
  buildPersistentSessionAttachCommand,
  buildPersistentSessionBackendProbeCommand,
  buildPersistentSessionDeleteCommand,
} from "../../src/core/ssh-persistent-session";

describe("buildPersistentSessionBackendProbeCommand", () => {
  test("preserves the dtach exit status instead of piping through head", () => {
    const command = buildPersistentSessionBackendProbeCommand();

    expect(command).toContain("command -v dtach >/dev/null 2>&1");
    expect(command).toContain("dtach --help >/dev/null 2>&1");
    expect(command).not.toContain("|");
    expect(command).not.toContain("head -n 1");
  });
});

describe("buildPersistentSessionDeleteCommand", () => {
  const session = {
    config: {
      id: "test-session-id",
      remoteSessionName: "ralpher-test123",
    },
  };

  test("kills dtach master before the shell to allow PTY hangup cascade", () => {
    const command = buildPersistentSessionDeleteCommand(session);
    const masterKillIndex = command.indexOf("kill \"$master_pid\"");
    const shellWaitIndex = command.indexOf("kill -0 \"$shell_pid\"");

    expect(masterKillIndex).toBeGreaterThan(-1);
    expect(shellWaitIndex).toBeGreaterThan(-1);
    expect(masterKillIndex).toBeLessThan(shellWaitIndex);
  });

  test("does not send SIGTERM to the shell — relies on SIGHUP from PTY hangup", () => {
    const command = buildPersistentSessionDeleteCommand(session);

    // The only signal sent to shell_pid should be SIGKILL (fallback), never SIGTERM.
    expect(command).not.toContain("kill \"$shell_pid\"");
    expect(command).toContain("kill -9 \"$shell_pid\"");
  });

  test("polls for shell exit before resorting to SIGKILL", () => {
    const command = buildPersistentSessionDeleteCommand(session);

    expect(command).toContain("while kill -0 \"$shell_pid\" 2>/dev/null && [ \"$wait_count\" -lt 20 ]");
    expect(command).toContain("sleep 0.1");
  });

  test("has a SIGKILL fallback for the dtach master", () => {
    const command = buildPersistentSessionDeleteCommand(session);

    expect(command).toContain("kill -9 \"$master_pid\"");
  });

  test("cleans up all session files", () => {
    const command = buildPersistentSessionDeleteCommand(session);

    expect(command).toContain("rm -f");
    expect(command).toContain("$client_tty_file");
    expect(command).toContain("$session_tty_file");
    expect(command).toContain("$session_pid_file");
    expect(command).toContain("$session_master_pid_file");
    expect(command).toContain("$session_socket");
  });
});

describe("buildPersistentSessionAttachCommand stale session cleanup", () => {
  const session = {
    config: {
      id: "test-attach-id",
      remoteSessionName: "ralpher-attach123",
      directory: "/tmp/test",
    },
  };

  test("kills dtach master before the shell when cleaning up a stale session", () => {
    const command = buildPersistentSessionAttachCommand(session);

    // The stale cleanup helper should kill the master first, then wait for shell.
    expect(command).toContain("terminate_stale_session");
    const fnBody = command.slice(command.indexOf("terminate_stale_session()"));
    const masterKillIndex = fnBody.indexOf("kill \"$mpid\"");
    const shellWaitIndex = fnBody.indexOf("kill -0 \"$spid\"");

    expect(masterKillIndex).toBeGreaterThan(-1);
    expect(shellWaitIndex).toBeGreaterThan(-1);
    expect(masterKillIndex).toBeLessThan(shellWaitIndex);
  });

  test("has a SIGKILL fallback for stale shell processes", () => {
    const command = buildPersistentSessionAttachCommand(session);

    expect(command).toContain("kill -9 \"$spid\"");
  });

  test("has a SIGKILL fallback for the dtach master", () => {
    const command = buildPersistentSessionAttachCommand(session);

    expect(command).toContain("kill -9 \"$mpid\"");
  });

  test("starts tmux inside the persistent shell when it is available", () => {
    const command = buildPersistentSessionAttachCommand(session);

    expect(command).toContain("if command -v tmux >/dev/null 2>&1; then");
    expect(command).toContain("exec tmux new-session \\; set-option destroy-unattached on;");
  });

  test("falls back to the interactive shell when tmux is unavailable", () => {
    const command = buildPersistentSessionAttachCommand(session);

    expect(command).toContain("shell=\"${SHELL:-/bin/sh}\";");
    expect(command).toContain("\"$shell\" -i");
  });
});
