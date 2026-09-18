import { describe, expect, test } from "bun:test";
import { LocalAcpTransportLifecycle } from "../../src/backends/acp";
import { SubprocessTreeTerminationError } from "../../src/core/subprocess-termination";

describe("local ACP transport lifecycle", () => {
  // An unconfirmed Windows tree cannot be reproduced through a public session
  // without risking unrelated host processes, so this seam verifies terminal
  // lifecycle state after the cleanup boundary declares the PID unrecoverable.
  test("releases ownership after an unrecoverable process cleanup", async () => {
    const lifecycle = new LocalAcpTransportLifecycle();
    const cleanupError = new SubprocessTreeTerminationError(
      "process-tree cleanup could not be confirmed",
      false,
    );
    const processOwner = {
      getChild(): { pid: number } {
        return { pid: 4242 };
      },
    };
    const internals = lifecycle as unknown as {
      connected: boolean;
      process: typeof processOwner | null;
      terminateProcess(process: typeof processOwner | null): Promise<void>;
    };
    internals.connected = true;
    internals.process = processOwner;
    internals.terminateProcess = async () => {
      throw cleanupError;
    };

    await expect(lifecycle.disconnect()).rejects.toBe(cleanupError);
    expect(lifecycle.isConnected()).toBe(false);
    expect(lifecycle.hasProcess()).toBe(false);
  });
});
