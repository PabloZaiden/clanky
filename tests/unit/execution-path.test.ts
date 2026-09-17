import { describe, expect, test } from "bun:test";
import {
  normalizeExecutionPath,
  normalizeExecutionRoot,
  resolveExecutionPath,
  resolveExecutionPathFromDirectory,
  resolveExecutionPathWithinDirectory,
} from "../../src/core/execution-path";
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
