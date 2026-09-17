import { describe, expect, test } from "bun:test";
import {
  normalizeExecutionRoot,
  resolveExecutionPath,
} from "../../src/core/execution-path";

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
});
