import { describe, expect, test } from "bun:test";
import {
  inferExecutionPathStyle,
  normalizeExecutionPath,
  normalizeExecutionRoot,
  resolveExecutionPath,
  resolveExecutionPathFromDirectory,
  resolveExecutionPathWithinDirectory,
} from "../../src/core/execution-path";
import { resolveCommandWorkingDirectory } from "../../src/core/command-execution-service";
import { readValidatedPlanningFiles } from "../../src/core/planning-file-service";
import { TestCommandExecutor } from "../mocks/mock-executor";

class RelativePlanningFileExecutor extends TestCommandExecutor {
  override readonly pathStyle = "posix";

  override async getExecutionDirectory(): Promise<string> {
    return "/resolved/repository";
  }

  override async readFile(path: string): Promise<string | null> {
    if (path === "/resolved/repository/plans/plan.md") {
      return "# Relative plan";
    }
    if (path === "/resolved/repository/plans/status.md") {
      return "# Relative status";
    }
    return null;
  }
}

describe("execution path containment", () => {
  // This pure contract protects path containment for host path syntaxes that are
  // unavailable on the current CI operating system.
  test("resolves POSIX and Windows paths without allowing lexical escapes", () => {
    expect(resolveExecutionPath("/workspaces/repo", "src/index.ts", "posix"))
      .toBe("/workspaces/repo/src/index.ts");
    expect(() =>
      resolveExecutionPath("/workspaces/repo", "../outside.txt", "posix")
    ).toThrow("Requested path must stay within the execution root.");

    expect(resolveExecutionPath(
      "C:\\Workspaces\\Repo",
      "src\\index.ts",
      "windows",
    )).toBe("C:\\Workspaces\\Repo\\src\\index.ts");
    expect(resolveExecutionPath(
      "C:\\Workspaces\\Repo",
      "c:\\workspaces\\repo\\README.md",
      "windows",
    )).toBe("c:\\workspaces\\repo\\README.md");
    expect(() =>
      resolveExecutionPath(
        "C:\\Workspaces\\Repo",
        "C:\\Workspaces\\Other\\secrets.txt",
        "windows",
      )
    ).toThrow("Requested path must stay within the execution root.");
  });

  test("supports UNC roots while rejecting Windows device namespaces", () => {
    expect(resolveExecutionPath(
      "\\\\server\\share\\repo",
      "src\\index.ts",
      "windows",
    )).toBe("\\\\server\\share\\repo\\src\\index.ts");
    expect(() =>
      resolveExecutionPath(
        "\\\\server\\share\\repo",
        "\\\\server\\other\\secrets.txt",
        "windows",
      )
    ).toThrow("Requested path must stay within the execution root.");
    expect(() =>
      normalizeExecutionRoot("\\\\?\\C:\\workspaces\\repo", "windows")
    ).toThrow("Execution root uses an unsupported Windows path form.");
    expect(() =>
      resolveExecutionPath(
        "C:\\workspaces\\repo",
        "\\\\.\\PhysicalDrive0",
        "windows",
      )
    ).toThrow("Requested path uses an unsupported Windows path form.");
    expect(() =>
      resolveExecutionPath("C:\\workspaces\\repo", "NUL.txt", "windows")
    ).toThrow("Requested path uses an unsupported Windows path form.");
    expect(() =>
      resolveExecutionPath("C:\\workspaces\\repo", "notes.txt:secret", "windows")
    ).toThrow("Requested path uses an unsupported Windows path form.");
  });

  test("preserves valid host-specific components during normalization", () => {
    expect(normalizeExecutionPath("/workspaces/repo/task\\", "posix"))
      .toBe("/workspaces/repo/task\\");
    expect(normalizeExecutionPath(
      String.raw`.\.clanky-planning\plan.md`,
      "windows",
    )).toBe(String.raw`.clanky-planning\plan.md`);
    expect(() =>
      normalizeExecutionPath(String.raw`plans\task.`, "windows")
    ).toThrow("Path uses an unsupported Windows path form.");
    expect(inferExecutionPathStyle("/srv/worktrees")).toBe("posix");
    expect(inferExecutionPathStyle(String.raw`C:\worktrees`)).toBe("windows");
    expect(inferExecutionPathStyle(String.raw`\\server\share\worktrees`))
      .toBe("windows");
    expect(inferExecutionPathStyle("//srv/worktrees")).toBe("posix");
    expect(inferExecutionPathStyle("relative/worktrees")).toBeNull();
  });

  test("resolves paths from relative execution directories without allowing escapes", () => {
    expect(resolveExecutionPathFromDirectory(
      "workspaces/repo",
      ".git/info/exclude",
      "posix",
    )).toBe("workspaces/repo/.git/info/exclude");
    expect(resolveExecutionPathWithinDirectory(
      String.raw`workspaces\repo`,
      String.raw`.\plans\..\plan.md`,
      "windows",
    )).toBe(String.raw`workspaces\repo\plan.md`);
    expect(() =>
      resolveExecutionPathWithinDirectory(
        "workspaces/repo",
        "../outside.md",
        "posix",
      )
    ).toThrow("Requested path must stay within the execution directory.");
    expect(() =>
      resolveExecutionPathWithinDirectory(
        String.raw`workspaces\repo`,
        String.raw`..\outside.md`,
        "windows",
      )
    ).toThrow("Requested path must stay within the execution directory.");
  });

  // Command cwd portability is a stable host-boundary contract that cannot be
  // exercised with Windows drive and UNC semantics on a POSIX test runner.
  test("resolves command working directories with host path semantics", () => {
    const errors = { cwdInvalid: "test_cwd_invalid" };
    expect(resolveCommandWorkingDirectory(
      String.raw`C:\workspaces\repo`,
      String.raw`src\app`,
      "windows",
      errors,
    )).toBe(String.raw`C:\workspaces\repo\src\app`);
    expect(resolveCommandWorkingDirectory(
      String.raw`C:\workspaces\repo`,
      String.raw`D:\shared tools`,
      "windows",
      errors,
    )).toBe(String.raw`D:\shared tools`);
    expect(resolveCommandWorkingDirectory(
      String.raw`\\server\share\repo`,
      String.raw`.\scripts`,
      "windows",
      errors,
    )).toBe(String.raw`\\server\share\repo\scripts`);
    expect(resolveCommandWorkingDirectory(
      " node_modules ",
      " bin ",
      "posix",
      errors,
    )).toBe("node_modules/bin");
    expect(() => resolveCommandWorkingDirectory(
      String.raw`C:\workspaces\repo`,
      "C:relative",
      "windows",
      errors,
    )).toThrow("The execution cwd is not a valid path for the selected host.");
  });

  test("reads planning files from the executor's canonical absolute directory", async () => {
    const files = await readValidatedPlanningFiles(
      new RelativePlanningFileExecutor(),
      "relative/repository",
      "./plans/plan.md",
    );

    expect(files).toEqual({
      planContent: "# Relative plan",
      statusContent: "# Relative status",
    });
  });
});
