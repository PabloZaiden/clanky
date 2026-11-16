import { WorkspaceEnvironmentStatusSchema, type WorkspaceEnvironmentStatus } from "@/contracts/schemas/environments";
import type { Workspace } from "@/shared/workspace";
import { DomainError } from "../../domain/domain-error";
import { closeCommandExecutor } from "../command-executor";
import { executionHostService } from "../execution-host-service";
import { environmentCommand } from "./command";

export async function executeWorkspaceEnvironmentOperation(
  workspace: Workspace,
  userId: string,
  operation: "status" | "stop" | "remove",
  signal?: AbortSignal,
  resetCredentials = false,
): Promise<WorkspaceEnvironmentStatus | { success: true }> {
  if (!workspace.provisioningHostBinding || !workspace.sourceDirectory) {
    throw new DomainError("environment_not_managed", "This workspace has no Clanky-managed environment.");
  }
  const binding = workspace.provisioningHostBinding;
  executionHostService.requireBindingCapability(binding, "environmentLifecycle", userId);
  const executor = await executionHostService.getCommandExecutor(binding, {
    directory: "/", localUserId: userId, operationId: `environment:${workspace.id}:${crypto.randomUUID()}`,
  });
  try {
    const invocation = environmentCommand(binding.host, userId, [
      operation, "--directory", workspace.sourceDirectory,
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
    return { success: true };
  } finally { closeCommandExecutor(executor); }
}
