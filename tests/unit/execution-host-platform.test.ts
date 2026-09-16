import { describe, expect, test } from "bun:test";
import {
  createExecutionHostRuntimeSnapshot,
  normalizeExecutionHostPlatform,
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
        serverHealth: 1,
      },
    });
  });
});
