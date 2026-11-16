import type { WorkspaceEnvironmentStatus } from "@/contracts/schemas/environments";
import { requireCurrentUserId } from "../../context/user-context";
import { backendManager } from "../backend-manager";
import { requireWorkspaceAccess } from "../collaboration-authority";
import { workspaceManager } from "../workspace-manager";
import { withWorkspaceRuntimeLock } from "../workspace-execution-lock";
import { executeWorkspaceEnvironmentOperation } from "./workspace-operation";

export async function workspaceEnvironmentOperation(
  workspaceId: string,
  operation: "status" | "stop" | "remove",
  signal: AbortSignal,
  resetCredentials = false,
): Promise<WorkspaceEnvironmentStatus | { success: true }> {
  requireWorkspaceAccess(workspaceId, "admin");
  const userId = requireCurrentUserId();
  const workspace = await workspaceManager.requireWorkspace(workspaceId);
  const run = async () => {
    const result = await executeWorkspaceEnvironmentOperation(workspace, userId, operation, signal, resetCredentials);
    if (operation !== "status") await backendManager.resetWorkspaceConnection(workspaceId);
    return result;
  };
  return operation === "status" ? await run() : await withWorkspaceRuntimeLock(workspaceId, run);
}
