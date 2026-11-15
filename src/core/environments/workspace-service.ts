import { WorkspaceEnvironmentStatusSchema, type WorkspaceEnvironmentStatus } from "@/contracts/schemas/environments";
import { requireCurrentUserId } from "../../context/user-context";
import { DomainError } from "../../domain/domain-error";
import { backendManager } from "../backend-manager";
import { closeCommandExecutor } from "../command-executor";
import { requireWorkspaceAccess } from "../collaboration-authority";
import { executionHostService } from "../execution-host-service";
import { workspaceManager } from "../workspace-manager";
import { withWorkspaceRuntimeLock } from "../workspace-execution-lock";
import { environmentCommand } from "./command";

export async function workspaceEnvironmentOperation(
  workspaceId: string,
  operation: "status" | "stop" | "remove",
  signal: AbortSignal,
  resetCredentials = false,
): Promise<WorkspaceEnvironmentStatus | { success: true }> {
  requireWorkspaceAccess(workspaceId, "admin");
  const userId = requireCurrentUserId();
  const workspace = await workspaceManager.requireWorkspace(workspaceId);
  if (!workspace.provisioningHostBinding || !workspace.sourceDirectory) {
    throw new DomainError("environment_not_managed", "This workspace has no Clanky-managed environment.");
  }
  const binding = workspace.provisioningHostBinding;
  executionHostService.requireBindingCapability(binding, "environmentLifecycle", userId);
  const run = async () => {
    const executor = await executionHostService.getCommandExecutor(binding, {
      directory: "/", localUserId: userId, operationId: `environment:${workspaceId}:${crypto.randomUUID()}`,
    });
    try {
      const invocation = environmentCommand(binding.host, userId, [
        operation, "--directory", workspace.sourceDirectory!,
        ...(resetCredentials ? ["--reset-credentials"] : []),
      ]);
      const result = await executor.exec(invocation.command, invocation.args, {
        cwd: "/", signal, timeout: operation === "status" ? 15_000 : 60_000,
        longRunning: operation !== "status", retryStart: false,
      });
      if (!result.success) throw new DomainError("environment_operation_failed", "The environment operation failed on the provisioning host.", {
        details: { operation, diagnostic: result.stderr.trim().slice(-4000) },
      });
      if (operation === "status") return WorkspaceEnvironmentStatusSchema.parse(JSON.parse(result.stdout));
      await backendManager.resetWorkspaceConnection(workspaceId);
      return { success: true as const };
    } finally { closeCommandExecutor(executor); }
  };
  return operation === "status" ? await run() : await withWorkspaceRuntimeLock(workspaceId, run);
}
