import { describe, expect, test } from "bun:test";
import {
  createFileExplorerRequestScope,
} from "../../src/hooks/file-explorer-request-scope";
import {
  createFileExplorerMutationCoordinator,
} from "../../src/hooks/file-explorer-mutation-coordinator";
import {
  createFileExplorerTreeLoadCoordinator,
} from "../../src/hooks/file-explorer-tree-load-coordinator";

function createWorkspaceScope(id: string) {
  return createFileExplorerRequestScope({
    type: "workspace",
    id,
  });
}

describe("file explorer concurrency", () => {
  test("keeps an active mutation owner and rejects incompatible work", () => {
    const scope = createWorkspaceScope("workspace-a");
    const coordinator = createFileExplorerMutationCoordinator();
    const firstResult = coordinator.begin(scope, "save");
    const firstOwner = firstResult.owner;

    expect(firstResult.reason).toBe("started");
    expect(firstOwner).not.toBeNull();
    if (!firstOwner) {
      return;
    }

    const secondResult = coordinator.begin(scope, "rename");
    expect(secondResult.reason).toBe("busy");
    expect(secondResult.owner).toBeNull();
    expect(coordinator.isCurrent(scope, firstOwner)).toBe(true);
    expect(firstOwner.operation.signal.aborted).toBe(false);

    expect(coordinator.finish(firstOwner)).toBe(true);
    expect(coordinator.isCurrent(scope, firstOwner)).toBe(false);
    const finalResult = coordinator.begin(scope, "delete");
    expect(finalResult.reason).toBe("started");
    expect(finalResult.owner).not.toBeNull();
    if (finalResult.owner) {
      expect(coordinator.finish(finalResult.owner)).toBe(true);
    }
  });

  test("aborts the previous owner when the target changes", () => {
    const firstScope = createWorkspaceScope("workspace-a");
    const secondScope = createWorkspaceScope("workspace-b");
    const coordinator = createFileExplorerMutationCoordinator();
    const firstResult = coordinator.begin(firstScope, "save");
    const firstOwner = firstResult.owner;

    expect(firstOwner).not.toBeNull();
    if (!firstOwner) {
      return;
    }

    const secondResult = coordinator.begin(secondScope, "rename");
    expect(secondResult.reason).toBe("started");
    expect(firstOwner.operation.signal.aborted).toBe(true);
    expect(secondResult.owner).not.toBeNull();
    if (secondResult.owner) {
      expect(coordinator.isCurrent(secondScope, secondResult.owner)).toBe(true);
    }
  });

  test("invalidates a mutation owner when its external signal is aborted", () => {
    const scope = createWorkspaceScope("workspace-a");
    const coordinator = createFileExplorerMutationCoordinator();
    const controller = new AbortController();
    const result = coordinator.begin(scope, "upload", controller.signal);
    const owner = result.owner;

    expect(owner).not.toBeNull();
    if (!owner) {
      return;
    }

    controller.abort();
    expect(owner.operation.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(scope, owner)).toBe(false);
    expect(coordinator.finish(owner)).toBe(true);
  });

  test("keeps loading ownership until the newest full-tree request finishes", () => {
    const scope = createWorkspaceScope("workspace-a");
    const coordinator = createFileExplorerTreeLoadCoordinator();
    const first = coordinator.begin(scope, "tree:full");
    const second = coordinator.begin(scope, "tree:full");

    expect(first.isCurrent()).toBe(false);
    expect(first.signal.aborted).toBe(true);
    expect(second.isCurrent()).toBe(true);
    expect(coordinator.isLoading()).toBe(true);
    expect(coordinator.finish(scope, first)).toBe(false);
    expect(coordinator.isLoading()).toBe(true);
    expect(coordinator.finish(scope, second)).toBe(true);
    expect(coordinator.isLoading()).toBe(false);
  });

  test("allows independent directories while superseding only repeated loads", () => {
    const scope = createWorkspaceScope("workspace-a");
    const coordinator = createFileExplorerTreeLoadCoordinator();
    const sourceFirst = coordinator.begin(scope, "tree:directory:src");
    const docs = coordinator.begin(scope, "tree:directory:docs");
    const sourceSecond = coordinator.begin(scope, "tree:directory:src");

    expect(sourceFirst.isCurrent()).toBe(false);
    expect(sourceFirst.signal.aborted).toBe(true);
    expect(docs.isCurrent()).toBe(true);
    expect(sourceSecond.isCurrent()).toBe(true);
    expect(coordinator.isLoading()).toBe(true);
    expect(coordinator.finish(scope, sourceFirst)).toBe(false);
    expect(coordinator.finish(scope, docs)).toBe(false);
    expect(coordinator.isLoading()).toBe(true);
    expect(coordinator.finish(scope, sourceSecond)).toBe(true);
    expect(coordinator.isLoading()).toBe(false);
  });

  test("disposes tree work when the target scope is disposed", () => {
    const scope = createWorkspaceScope("workspace-a");
    const coordinator = createFileExplorerTreeLoadCoordinator();
    const operation = coordinator.begin(scope, "tree:full");

    scope.dispose();
    coordinator.dispose();

    expect(operation.signal.aborted).toBe(true);
    expect(operation.isCurrent()).toBe(false);
    expect(coordinator.isLoading()).toBe(false);
  });
});
