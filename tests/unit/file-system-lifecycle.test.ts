/**
 * Scheduling/cancellation exception: HTTP cannot deterministically pause after
 * host metadata and before a non-cancellable mutation. Gate that external seam
 * on a real executor and assert filesystem effects, not calls/private queues.
 * Existing DAV upload cancellation covers transfer, not this commit boundary.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithCurrentUser } from "../../src/context/user-context";
import { FileSystemService } from "../../src/core/file-system-service";
import type { FileExplorerTarget } from "../../src/core/file-explorer-service";
import { CommandExecutorImpl } from "../../src/core/remote-executor";
import { pollUntil } from "../helpers/polling";

const user: CurrentUser = {
  id: "filesystem-lifecycle", username: "filesystem-lifecycle",
  role: "owner", isOwner: true, isAdmin: true,
};

class MetadataGateExecutor extends CommandExecutorImpl {
  readonly entered = Promise.withResolvers<void>();
  readonly resumed = Promise.withResolvers<void>();

  constructor(directory: string, private readonly pause: (path: string) => boolean | Promise<boolean>) {
    super({ directory });
  }

  override async getFileMetadata(
    path: string, options?: Parameters<CommandExecutorImpl["getFileMetadata"]>[1],
  ) {
    const metadata = await super.getFileMetadata(path, options);
    if (await this.pause(path)) {
      this.entered.resolve();
      await this.resumed.promise;
    }
    return metadata;
  }
}

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "clanky-filesystem-lifecycle-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function target(executor: CommandExecutorImpl, identity: string): FileExplorerTarget {
  return { id: identity, fileSystemIdentity: identity, rootDirectory: directory, executor };
}

test("filesystem lifecycle allows another physical target to progress during slow host metadata", async () => {
  await runWithCurrentUser(user, async () => {
    const service = new FileSystemService();
    const first = join(directory, "slow.txt");
    const second = join(directory, "independent.txt");
    await Bun.write(first, "slow");
    await Bun.write(second, "independent");
    const executor = new MetadataGateExecutor(directory, (path) => path === first);
    const slow = service.execute(target(executor, "slow-host"), { operation: "delete", path: first });
    await executor.entered.promise;
    const independent = service.execute(target(new CommandExecutorImpl({ directory }), "other-host"), {
      operation: "delete", path: second,
    });
    try {
      await pollUntil(
        () => Bun.file(second).exists(), (exists) => !exists,
        { description: "independent target deletion while slow target remains gated", timeoutMs: 2_000 },
      );
      expect(await Bun.file(first).text()).toBe("slow");
    } finally {
      executor.resumed.resolve();
      await Promise.allSettled([slow, independent]);
    }
    expect(await Bun.file(first).exists()).toBe(false);
  });
});

for (const operation of ["delete", "move", "write"] as const) {
  test(`filesystem lifecycle cancels ${operation} after metadata without committing`, async () => {
    await runWithCurrentUser(user, async () => {
      const service = new FileSystemService();
      const source = join(directory, "source.txt");
      const destination = join(directory, "destination.txt");
      await Bun.write(source, "source");
      await Bun.write(destination, "original");
      const executor = new MetadataGateExecutor(directory, async (path) => {
        if (operation === "delete") return path === source;
        if (path !== destination) return false;
        return operation === "move"
          || (await readdir(directory)).some((name) => name.startsWith(".clanky-upload-"));
      });
      const host = target(executor, "host");
      const controller = new AbortController();
      const pending = operation === "write"
        ? service.write({
            target: host, path: destination, conditions: {}, signal: controller.signal,
            stream: new Blob(["replacement"]).stream(),
          })
        : service.execute(host, operation === "delete"
            ? { operation, path: source }
            : { operation, path: source, destination, overwrite: true, depth: "infinity" },
          controller.signal);
      try {
        await executor.entered.promise;
        controller.abort();
        executor.resumed.resolve();
        await expect(pending).rejects.toThrow();
        expect(await Bun.file(source).text()).toBe("source");
        expect(await Bun.file(destination).text()).toBe("original");
        expect((await readdir(directory)).filter((name) => name.startsWith(".clanky-upload-"))).toEqual([]);
      } finally {
        executor.resumed.resolve();
        await Promise.allSettled([pending]);
      }
    });
  });
}
