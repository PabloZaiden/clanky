import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  fileExplorerService,
  resolveFileExplorerRootDirectory,
} from "../../src/core/file-explorer-service";
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

describe("fileExplorerService.listDirectory", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  test("uses a single metadata batch call for directory entries", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-service-"));
    tempDirectories.push(rootDirectory);
    await mkdir(join(rootDirectory, "src"), { recursive: true });
    await writeFile(join(rootDirectory, "README.md"), "# hello\n");
    await writeFile(join(rootDirectory, "package.json"), "{}\n");

    const executor = new TestCommandExecutor();
    const execSpy = spyOn(executor, "exec");

    const result = await fileExplorerService.listDirectory({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor,
    });

    expect(result.entries.map((entry) => entry.name)).toEqual(["src", "package.json", "README.md"]);
    expect(execSpy).toHaveBeenCalledTimes(2);
    expect(execSpy.mock.calls[1]?.[0]).toBe("bash");
    expect(execSpy.mock.calls[1]?.[1]?.[2]).toBe("file-explorer-batch-metadata");
  });
});
