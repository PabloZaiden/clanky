import { describe, expect, test } from "bun:test";
import {
  createFileExplorerRequestScope,
  getFileExplorerTargetKey,
} from "../../src/hooks/file-explorer-request-scope";

describe("file explorer request scope", () => {
  test("includes target type, ID, and start directory in the target key", () => {
    const workspaceKey = getFileExplorerTargetKey({
      type: "workspace",
      id: "workspace-a",
      startDirectory: "src",
    });
    const serverKey = getFileExplorerTargetKey({
      type: "server",
      id: "workspace-a",
      startDirectory: "src",
    });
    const otherDirectoryKey = getFileExplorerTargetKey({
      type: "workspace",
      id: "workspace-a",
      startDirectory: "docs",
    });

    expect(workspaceKey).not.toBe(serverKey);
    expect(workspaceKey).not.toBe(otherDirectoryKey);
  });

  test("invalidates operations when the target scope is disposed", () => {
    const scope = createFileExplorerRequestScope({
      type: "workspace",
      id: "workspace-a",
    });
    const operation = scope.createOperation();

    expect(operation.isCurrent()).toBe(true);
    expect(operation.signal.aborted).toBe(false);

    scope.dispose();

    expect(scope.signal.aborted).toBe(true);
    expect(operation.isCurrent()).toBe(false);
  });

  test("invalidates an operation when its own signal is aborted", () => {
    const scope = createFileExplorerRequestScope({
      type: "server",
      id: "server-a",
    });
    const operationController = new AbortController();
    const operation = scope.createOperation(operationController.signal);

    expect(operation.isCurrent()).toBe(true);
    operationController.abort();

    expect(operation.signal.aborted).toBe(true);
    expect(operation.isCurrent()).toBe(false);
  });
});

