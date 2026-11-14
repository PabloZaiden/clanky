/**
 * Upgrade-only cleanup. Unknown ownership or writer state always retains inventory.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { ExecutionHostBindingSchema } from "@/contracts/schemas/execution-host";
import { HarnessConversationBindingSchema } from "@/contracts/schemas/harness";
import { requireMatchingHarnessBindings } from "../backends/harness-binding";
import { HarnessError } from "../backends/harness-errors";
import { runWithExecutionOwner } from "../context/user-context";
import { getAccountStore } from "../persistence/database";
import { toCurrentUser } from "../persistence/users";
import {
  completeRetiredTaskCleanup,
  getRetirementProtectedDirectories,
  listRetiredTaskResources,
  recordRetiredTaskCleanupFailure,
  RetiredTaskInventorySchema,
  saveRetiredTaskResources,
  type RetiredTaskInventory,
} from "../persistence/retired-task-resources";
import { backendManager } from "./backend-manager";
import { closeCommandExecutor, resolveCommandExecutorDirectory } from "./command-executor";
import { conversationAttachmentService } from "./conversation-attachment-service";
import { executionPathsEqual, isExecutionPathWithinRoot } from "./execution-path";
import { executionHostService } from "./execution-host-service";
import { GitService } from "./git";
import { ManagedPathService } from "./managed-path-service";

const log = createLogger("core:retired-task-cleanup");

async function settleWriters(userId: string, inventory: RetiredTaskInventory): Promise<void> {
  for (const saved of inventory.sessions) {
    if (saved.deleted) continue;
    if (!saved.bindingJson) throw new Error("A retired execution has no verifiable saved ownership binding.");
    const binding = HarnessConversationBindingSchema.parse(JSON.parse(saved.bindingJson));
    if (binding.ownerId !== userId || binding.contextId !== saved.contextId || binding.nativeId !== saved.nativeId) {
      throw new Error("A retired execution's saved ownership does not match its cleanup inventory.");
    }
    const host = ExecutionHostBindingSchema.parse(binding.executionHost);
    await backendManager.withExecutionHostBackend({
      binding: host,
      provider: binding.adapter === "opencode2" ? "opencode" : binding.adapter,
      adapter: binding.adapter,
      directory: binding.directory,
    }, async (backend) => {
      try {
        // Retired roots must not reacquire application-control authority during cleanup.
        const session = await backend.resumeSession({ ...binding, controlTools: false });
        if (!session?.binding) throw new Error("The retired native execution could not be recovered for cleanup.");
        requireMatchingHarnessBindings(session.binding, binding);
        if (!saved.settled) {
          const result = await backend.harness.settleOwnedWork(saved.nativeId);
          if (result.status !== "settled") throw new Error("Retired native work has not confirmed writer settlement.");
          saved.settled = true;
          saveRetiredTaskResources(userId, inventory);
        }
        await backend.deleteSession(saved.nativeId);
      } catch (error) {
        if (!(saved.settled && error instanceof HarnessError && error.code === "harness_session_not_found")) throw error;
      }
      saved.deleted = true;
      saveRetiredTaskResources(userId, inventory);
    });
  }
  if (inventory.terminals.length) {
    throw new Error("Retired terminal cleanup is pending: historical terminal writer settlement cannot be verified.");
  }
  inventory.writersSettled = true;
  saveRetiredTaskResources(userId, inventory);
}

async function cleanupAttachments(userId: string, inventory: RetiredTaskInventory): Promise<void> {
  for (const location of [...inventory.attachments]) {
    const executor = await executionHostService.getCommandExecutor(
      ExecutionHostBindingSchema.parse(location.executionHost),
      { directory: location.directory, operationId: "retired-attachments", localUserId: userId },
    );
    try {
      const directory = await resolveCommandExecutorDirectory(executor, location.directory);
      const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify([userId, location.contextId])).digest("hex");
      await conversationAttachmentService.cleanupLocation(executor, directory, `${location.contextKind}-${hash}`);
      inventory.attachments.splice(inventory.attachments.indexOf(location), 1);
      saveRetiredTaskResources(userId, inventory);
    } finally {
      closeCommandExecutor(executor);
    }
  }
}

async function cleanupWorktrees(userId: string, inventory: RetiredTaskInventory): Promise<void> {
  const preserved: string[] = [];
  for (const resource of [...inventory.worktrees]) {
    const binding = ExecutionHostBindingSchema.parse(resource.executionHost);
    const executor = await executionHostService.getCommandExecutor(binding, {
      directory: resource.repositoryDirectory, operationId: "retired-worktree", localUserId: userId,
    });
    try {
      const repository = await resolveCommandExecutorDirectory(executor, resource.repositoryDirectory);
      const paths = new ManagedPathService(executor.pathStyle);
      const git = GitService.withExecutor(executor);
      let shared = false;
      if (resource.path) {
        const path = paths.assertCanonicalManagedWorktreePath(repository, resource.taskId, resource.path);
        shared = getRetirementProtectedDirectories(binding.targetKey)
          .some((directory) => isExecutionPathWithinRoot(path, directory, executor.pathStyle));
        if (shared) {
          log.warn("Preserving a retired worktree that is now shared with a current resource", { taskId: resource.taskId });
          preserved.push(`worktree ${resource.taskId}`);
          continue;
        } else {
          const trees = await git.listWorktrees(repository);
          const registered = trees.find((tree) => executionPathsEqual(tree.path, path, executor.pathStyle));
          if (registered && registered.branch !== resource.workingBranch) {
            throw new Error("A retired worktree now belongs to a different branch; cleanup requires review.");
          }
          await git.ensureWorktreeRemoved(repository, path, { force: true });
        }
      }
      if (!shared && resource.workingBranch && resource.originalBranch
        && resource.workingBranch !== resource.originalBranch) {
        const trees = await git.listWorktrees(repository);
        const defaultBranch = await git.getDefaultBranch(repository);
        if (resource.workingBranch === defaultBranch || trees.some((tree) => tree.branch === resource.workingBranch)) {
          log.warn("Preserving a retired working branch that is now shared or checked out", { taskId: resource.taskId });
          preserved.push(`branch for ${resource.taskId}`);
          continue;
        } else if (await git.branchExists(repository, resource.workingBranch)) {
          await git.deleteBranch(repository, resource.workingBranch);
        }
      }
      inventory.worktrees.splice(inventory.worktrees.indexOf(resource), 1);
      saveRetiredTaskResources(userId, inventory);
    } finally {
      closeCommandExecutor(executor);
    }
  }
  if (preserved.length) {
    throw new Error(`Retired resources remain protected by current usage: ${preserved.join(", ")}.`);
  }
}

export async function cleanupRetiredTaskResources(): Promise<void> {
  for (const row of listRetiredTaskResources()) {
    try {
      const owner = getAccountStore().getUserById(row.userId);
      if (!owner) throw new Error("The retired resource owner is unavailable; cleanup cannot be authorized.");
      const inventory = RetiredTaskInventorySchema.parse(JSON.parse(row.inventoryJson));
      await runWithExecutionOwner(toCurrentUser(owner), async () => {
        if (!inventory.writersSettled) await settleWriters(row.userId, inventory);
        await cleanupAttachments(row.userId, inventory);
        await cleanupWorktrees(row.userId, inventory);
      });
      completeRetiredTaskCleanup(row.userId);
      log.info("Retired Task resources were cleaned up", { userId: row.userId });
    } catch (error) {
      const message = String(error);
      recordRetiredTaskCleanupFailure(row.userId, message);
      log.error("Retired Task cleanup remains pending; ownership inventory was retained", {
        userId: row.userId, error: message,
      });
    }
  }
}
