import { describe, expect, test } from "bun:test";
import {
  blockAndCloseWorkspaceTerminalAttachment,
  claimWorkspaceTerminalAttachment,
  unblockWorkspaceTerminalAttachment,
} from "../../src/core/workspace-terminal-attachment-registry";

function createDisposableConnection(): {
  connection: { dispose: () => Promise<void> };
  getDisposeCount: () => number;
} {
  let disposeCount = 0;
  return {
    connection: {
      dispose: async () => {
        disposeCount += 1;
      },
    },
    getDisposeCount: () => disposeCount,
  };
}

describe("workspace terminal attachment registry", () => {
  test("disposes the previous attachment when a session is reattached", async () => {
    const sessionId = crypto.randomUUID();
    const first = createDisposableConnection();
    const second = createDisposableConnection();
    const firstHandle = await claimWorkspaceTerminalAttachment(sessionId, first.connection);
    const secondHandle = await claimWorkspaceTerminalAttachment(sessionId, second.connection);

    expect(first.getDisposeCount()).toBe(1);
    expect(firstHandle.isActive()).toBe(false);
    expect(secondHandle.isActive()).toBe(true);

    secondHandle.release();
  });

  test("blocks new attachments while closing and disposes the active connection", async () => {
    const sessionId = crypto.randomUUID();
    const current = createDisposableConnection();
    const handle = await claimWorkspaceTerminalAttachment(sessionId, current.connection);

    await blockAndCloseWorkspaceTerminalAttachment(sessionId);

    expect(current.getDisposeCount()).toBe(1);
    expect(handle.isActive()).toBe(false);
    await expect(
      claimWorkspaceTerminalAttachment(sessionId, createDisposableConnection().connection),
    ).rejects.toMatchObject({ code: "terminal_session_closing" });

    unblockWorkspaceTerminalAttachment(sessionId);
  });

  test("restores the previous attachment when replacing it fails", async () => {
    const sessionId = crypto.randomUUID();
    let previousDisposeCount = 0;
    const previous = {
      connection: {
        dispose: async () => {
          previousDisposeCount += 1;
          throw new Error("dispose failed");
        },
      },
    };
    const replacement = createDisposableConnection();
    const previousHandle = await claimWorkspaceTerminalAttachment(sessionId, previous.connection);

    await expect(
      claimWorkspaceTerminalAttachment(sessionId, replacement.connection),
    ).rejects.toThrow("dispose failed");

    expect(previousDisposeCount).toBe(1);
    expect(replacement.getDisposeCount()).toBe(1);
    expect(previousHandle.isActive()).toBe(true);
    previousHandle.release();
  });
});
