import { describe, expect, spyOn, test } from "bun:test";
import { resolveFileExplorerRootDirectory } from "../../src/core/file-explorer-service";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("resolveFileExplorerRootDirectory", () => {
  test("returns the default root without probing when no custom start directory is provided", async () => {
    const executor = new TestCommandExecutor();
    const execSpy = spyOn(executor, "exec");
    const directoryExistsSpy = spyOn(executor, "directoryExists");
    const fileExistsSpy = spyOn(executor, "fileExists");

    const rootDirectory = await resolveFileExplorerRootDirectory(executor, "/workspaces/project");

    expect(rootDirectory).toBe("/workspaces/project");
    expect(execSpy).not.toHaveBeenCalled();
    expect(directoryExistsSpy).not.toHaveBeenCalled();
    expect(fileExistsSpy).not.toHaveBeenCalled();
  });

  test("uses a single executor probe when validating a custom start directory", async () => {
    const executor = new TestCommandExecutor();
    const execSpy = spyOn(executor, "exec");
    const directoryExistsSpy = spyOn(executor, "directoryExists");
    const fileExistsSpy = spyOn(executor, "fileExists");

    const rootDirectory = await resolveFileExplorerRootDirectory(
      executor,
      "/workspaces/project",
      "/tmp",
    );

    expect(rootDirectory).toBe("/tmp");
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy.mock.calls[0]).toEqual([
      "bash",
      [
        "-lc",
        "if [ -d \"$1\" ]; then printf 'directory'; elif [ -e \"$1\" ]; then printf 'file'; else printf 'missing'; fi",
        "file-explorer-root-type",
        "/tmp",
      ],
      { logFailures: false },
    ]);
    expect(directoryExistsSpy).not.toHaveBeenCalled();
    expect(fileExistsSpy).not.toHaveBeenCalled();
  });
});
