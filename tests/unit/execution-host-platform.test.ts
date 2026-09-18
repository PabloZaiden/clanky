import { describe, expect, test } from "bun:test";
import {
  createExecutionHostRuntimeSnapshot,
  getUnavailableGitCommandCapability,
  normalizeExecutionHostPlatform,
  supportsAcpRuntime,
  supportsExecutionHostCapability,
  supportsGitCommandScope,
  supportsPortableAcpRuntime,
  supportsWorkspaceExecutionHost,
} from "../../src/shared/execution-host";

describe("Execution host platform contract", () => {
  // This pure contract covers the Windows branch that Linux CI cannot expose through the local-host API.
  test("normalizes Windows and advertises only implemented capabilities", () => {
    expect(normalizeExecutionHostPlatform("win32", "arm64")).toEqual({
      os: "windows",
      architecture: "arm64",
    });
    expect(createExecutionHostRuntimeSnapshot("win32", "x64")).toEqual({
      platform: {
        os: "windows",
        architecture: "x64",
      },
      capabilities: {
        commandExecution: 1,
        fileOperations: 2,
        git: 2,
        managedWorktrees: 2,
        acpRuntime: 2,
        interactiveTerminal: 1,
        tcpTunnel: 1,
        vnc: 1,
        serverHealth: 1,
      },
    });
    expect(supportsExecutionHostCapability({ fileOperations: 1 }, "fileOperations"))
      .toBe(false);
    expect(supportsGitCommandScope({
      commandExecution: 1,
      git: 1,
      managedWorktrees: 1,
    }, "managedWorktrees")).toBe(true);
    expect(supportsGitCommandScope({
      git: 1,
      managedWorktrees: 1,
    }, "managedWorktrees")).toBe(false);
    expect(getUnavailableGitCommandCapability({
      commandExecution: 1,
      git: 1,
      managedWorktrees: 1,
    }, "managedWorktrees")).toBeNull();
    expect(getUnavailableGitCommandCapability({
      git: 2,
    }, "managedWorktrees")).toBe("managedWorktrees");
    expect(supportsAcpRuntime({ acpRuntime: 1 })).toBe(true);
    expect(supportsPortableAcpRuntime({ acpRuntime: 1 })).toBe(false);
    expect(supportsPortableAcpRuntime({ acpRuntime: 2 })).toBe(true);
    expect(supportsWorkspaceExecutionHost({
      fileOperations: 2,
      acpRuntime: 1,
    })).toBe(true);
  });
});
