import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import {
  fileExplorerService,
  resolveFileExplorerRootDirectory,
} from "../../src/core/file-explorer-service";
import { TestCommandExecutor } from "../mocks/mock-executor";

const EXPECTED_DEFERRED_DIRECTORY_NAMES = [
  ".git",
  "node_modules",
  "vendor",
  "target",
  "obj",
  "bin",
  ".venv",
  "__pycache__",
  ".gradle",
  ".terraform",
  "Pods",
] as const;

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

  test("uses a single lightweight batch call for directory entries", async () => {
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
    expect(execSpy.mock.calls[1]?.[1]?.[2]).toBe("file-explorer-batch-nodes");
  });

  test("loads the full tree with a single traversal command and preserves empty directories", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-tree-"));
    tempDirectories.push(rootDirectory);
    await mkdir(join(rootDirectory, "src", "nested"), { recursive: true });
    await mkdir(join(rootDirectory, "empty-dir"), { recursive: true });
    await writeFile(join(rootDirectory, "src", "nested", "index.ts"), "export const value = 1;\n");

    const executor = new TestCommandExecutor();
    const execSpy = spyOn(executor, "exec");

    const result = await fileExplorerService.loadTree({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor,
    });

    expect(Object.keys(result.entriesByDirectory).sort()).toEqual(["", "empty-dir", "src", "src/nested"]);
    expect(result.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual(["empty-dir", "src"]);
    expect(result.entriesByDirectory["src/nested"]?.map((entry) => entry.path)).toEqual(["src/nested/index.ts"]);
    expect(result.entriesByDirectory["empty-dir"]).toEqual([]);
    expect(execSpy).toHaveBeenCalledTimes(1);
    expect(execSpy.mock.calls[0]?.[1]?.[2]).toBe("file-explorer-tree");
    for (const directoryName of EXPECTED_DEFERRED_DIRECTORY_NAMES) {
      expect(execSpy.mock.calls[0]?.[1]?.[1]).toContain(`-name '${directoryName}'`);
    }
    expect(execSpy.mock.calls[0]?.[1]?.[1]).toContain("-exec stat -c $'base\\t%n\\t%f\\n' {} +");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).toContain("find \"$root\" ! -path \"$root\"");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).toContain("-o -type l -exec stat -Lc $'link\\t%n\\t%f\\n' {} + 2>/dev/null || true");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).toContain("stat --version >/dev/null 2>&1");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("sha256sum");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("-mindepth");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("-xtype");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("-printf");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("%F");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("%HT");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("if [ -d \"$path\" ]");
    expect(execSpy.mock.calls[0]?.[1]?.[1]).not.toContain("tree ");
    expect(execSpy.mock.calls[0]?.[1]).toHaveLength(4);
    expect(execSpy.mock.calls[0]?.[2]).toEqual({ logFailures: false });
  });

  test("marks heavy directories for lazy expansion while pruning their descendants from the initial full tree", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-pruned-"));
    tempDirectories.push(rootDirectory);
    await mkdir(join(rootDirectory, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(rootDirectory, ".git", "objects"), { recursive: true });
    await mkdir(join(rootDirectory, "vendor", "github.com", "pkg"), { recursive: true });
    await mkdir(join(rootDirectory, "target", "debug"), { recursive: true });
    await mkdir(join(rootDirectory, "obj", "Debug"), { recursive: true });
    await mkdir(join(rootDirectory, ".venv", "lib"), { recursive: true });
    await mkdir(join(rootDirectory, "__pycache__"), { recursive: true });
    await writeFile(join(rootDirectory, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(join(rootDirectory, ".git", "config"), "[core]\n");
    await writeFile(join(rootDirectory, "vendor", "github.com", "pkg", "mod.go"), "package pkg\n");
    await writeFile(join(rootDirectory, "target", "debug", "app"), "binary\n");
    await writeFile(join(rootDirectory, "obj", "Debug", "app.dll"), "binary\n");
    await writeFile(join(rootDirectory, ".venv", "lib", "site.py"), "# venv\n");
    await writeFile(join(rootDirectory, "__pycache__", "module.pyc"), "pyc\n");
    await writeFile(join(rootDirectory, "README.md"), "# hello\n");

    const result = await fileExplorerService.loadTree({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor: new TestCommandExecutor(),
    });

    const rootEntries = result.entriesByDirectory[""]?.map((entry) => ({
      name: entry.name,
      loadOnExpand: entry.loadOnExpand ?? false,
    })) ?? [];
    expect(rootEntries).toEqual(expect.arrayContaining([
      { name: ".git", loadOnExpand: true },
      { name: ".venv", loadOnExpand: true },
      { name: "__pycache__", loadOnExpand: true },
      { name: "node_modules", loadOnExpand: true },
      { name: "obj", loadOnExpand: true },
      { name: "target", loadOnExpand: true },
      { name: "vendor", loadOnExpand: true },
      { name: "README.md", loadOnExpand: false },
    ]));
    expect(rootEntries).toHaveLength(8);
    expect(result.entriesByDirectory["node_modules"]).toBeUndefined();
    expect(result.entriesByDirectory[".git"]).toBeUndefined();
    expect(result.entriesByDirectory["vendor"]).toBeUndefined();
    expect(result.entriesByDirectory["target"]).toBeUndefined();
    expect(result.entriesByDirectory["obj"]).toBeUndefined();
    expect(result.entriesByDirectory[".venv"]).toBeUndefined();
    expect(result.entriesByDirectory["__pycache__"]).toBeUndefined();
  });

  test("loads executables and symlinks without tree suffix markers in the parsed paths", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-links-"));
    tempDirectories.push(rootDirectory);
    await mkdir(join(rootDirectory, "src"), { recursive: true });
    await writeFile(join(rootDirectory, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(rootDirectory, "run.sh"), "#!/usr/bin/env bash\necho hello\n");
    await chmod(join(rootDirectory, "run.sh"), 0o755);
    await symlink(join(rootDirectory, "src", "index.ts"), join(rootDirectory, "index-link"));
    await symlink(join(rootDirectory, "src"), join(rootDirectory, "src-link"));

    const result = await fileExplorerService.loadTree({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor: new TestCommandExecutor(),
    });

    expect(result.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual(["src", "src-link", "index-link", "run.sh"]);
    expect(result.entriesByDirectory[""]?.map((entry) => entry.path)).toEqual(["src", "src-link", "index-link", "run.sh"]);
    expect(result.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "file", "file"]);
    expect(result.entriesByDirectory["src-link"]).toEqual([]);
  });

  test("parses BSD stat output for symlink targets without needing GNU find flags", async () => {
    const rootDirectory = "/workspace/project";
    const executor: CommandExecutor = {
      async exec(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
        expect(command).toBe("bash");
        expect(args[2]).toBe("file-explorer-tree");
        for (const directoryName of EXPECTED_DEFERRED_DIRECTORY_NAMES) {
          expect(args[1]).toContain(`-name '${directoryName}'`);
        }
        expect(args[1]).toContain("stat -f $'base\\t%N\\t%p\\n'");
        expect(args[1]).toContain("stat -Lf $'link\\t%N\\t%p\\n'");
        return {
          success: true,
          stdout: [
            `base\t${rootDirectory}/src\t040755`,
            `base\t${rootDirectory}/src-link\t120777`,
            `base\t${rootDirectory}/index-link\t120777`,
            `base\t${rootDirectory}/run.sh\t100755`,
            `link\t${rootDirectory}/src-link\t040755`,
            `link\t${rootDirectory}/index-link\t100644`,
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
      async fileExists(_path: string): Promise<boolean> {
        return false;
      },
      async directoryExists(_path: string): Promise<boolean> {
        return false;
      },
      async readFile(_path: string): Promise<string | null> {
        return null;
      },
      async listDirectory(_path: string, _options?: { includeHidden?: boolean }): Promise<string[]> {
        return [];
      },
      async writeFile(_path: string, _content: string): Promise<boolean> {
        return false;
      },
    };

    const result = await fileExplorerService.loadTree({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor,
    });

    expect(result.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual(["src", "src-link", "index-link", "run.sh"]);
    expect(result.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "file", "file"]);
    expect(result.entriesByDirectory["src-link"]).toEqual([]);
  });

  test("keeps broken symlinks as file entries when link-target stat calls fail", async () => {
    const rootDirectory = "/workspace/project";
    const executor: CommandExecutor = {
      async exec(_command: string, _args: string[], _options?: CommandOptions): Promise<CommandResult> {
        return {
          success: true,
          stdout: [
            `base\t${rootDirectory}/src\t41ed`,
            `base\t${rootDirectory}/src-link\t41ed`,
            `base\t${rootDirectory}/broken-link\ta1ff`,
            `base\t${rootDirectory}/index-link\ta1ff`,
            `link\t${rootDirectory}/index-link\t81a4`,
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
      async fileExists(_path: string): Promise<boolean> {
        return false;
      },
      async directoryExists(_path: string): Promise<boolean> {
        return false;
      },
      async readFile(_path: string): Promise<string | null> {
        return null;
      },
      async listDirectory(_path: string, _options?: { includeHidden?: boolean }): Promise<string[]> {
        return [];
      },
      async writeFile(_path: string, _content: string): Promise<boolean> {
        return false;
      },
    };

    const result = await fileExplorerService.loadTree({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor,
    });

    expect(result.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual(["src", "src-link", "broken-link", "index-link"]);
    expect(result.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "file", "file"]);
    expect(result.entriesByDirectory["src-link"]).toEqual([]);
  });
});

describe("fileExplorerService file entries", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }));
  });

  test("includes the absolute path when reading a file", async () => {
    const rootDirectory = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-read-"));
    tempDirectories.push(rootDirectory);
    await mkdir(join(rootDirectory, "src"), { recursive: true });
    await writeFile(join(rootDirectory, "src", "index.ts"), "export const value = 1;\n");

    const result = await fileExplorerService.readFile({
      id: "workspace-1",
      rootDirectory,
      pathScopeLabel: "workspace root",
      executor: new TestCommandExecutor(),
    }, "src/index.ts");

    expect(result.file.path).toBe("src/index.ts");
    expect(result.file.absolutePath).toBe(join(rootDirectory, "src", "index.ts"));
    expect(result.content).toContain("value = 1");
  });

  test("includes the absolute path in metadata for alternate roots", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-alt-root-"));
    const alternateRoot = await mkdtemp(join(tmpdir(), "ralpher-file-explorer-alt-target-"));
    tempDirectories.push(workspaceRoot, alternateRoot);
    await mkdir(join(alternateRoot, "notes"), { recursive: true });
    await writeFile(join(alternateRoot, "notes", "todo.txt"), "remember the milk\n");

    const resolvedRootDirectory = await resolveFileExplorerRootDirectory(
      new TestCommandExecutor(),
      workspaceRoot,
      alternateRoot,
    );

    const result = await fileExplorerService.getMetadata({
      id: "workspace-1",
      rootDirectory: resolvedRootDirectory,
      pathScopeLabel: "workspace root",
      executor: new TestCommandExecutor(),
    }, "notes/todo.txt");

    expect(result).not.toBeNull();
    expect(result?.path).toBe("notes/todo.txt");
    expect(result?.absolutePath).toBe(join(alternateRoot, "notes", "todo.txt"));
  });
});
