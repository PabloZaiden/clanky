/**
 * Core maintenance operations for destructive settings actions.
 *
 * This service owns connection reset and automatic workspace restart
 * orchestration. API routes only apply authorization and response mapping.
 */

import { deleteAndReinitializeDatabase } from "../persistence/database";
import type {
  RestartAutomaticWorkspacesRequest,
  RestartAutomaticWorkspacesResult,
} from "@/contracts";
import { isRestartableAutomaticWorkspace } from "@/shared";
import { backendManager } from "./backend-manager";
import { DomainError, isDomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { provisioningManager } from "./provisioning-manager";
import { workspaceManager } from "./workspace-manager";
import { stopChatTrashMaintenance, startChatTrashMaintenance } from "./chat-trash-maintenance";

const log = createLogger("core:settings-maintenance");
export class SettingsMaintenanceService {
  async resetAll(): Promise<void> {
    await stopChatTrashMaintenance();
    log.debug("Resetting all backend connections before database reset");
    try {
      await backendManager.resetAllConnections();
      log.debug("Deleting and reinitializing database");
      await deleteAndReinitializeDatabase();
    } catch (error) {
      throw new DomainError("reset_failed", String(error), { cause: error });
    } finally {
      startChatTrashMaintenance();
    }
  }

  async restartAutomaticWorkspaces(
    _request: RestartAutomaticWorkspacesRequest,
  ): Promise<RestartAutomaticWorkspacesResult> {
    const workspaces = await workspaceManager.listWorkspaces();
    const automaticWorkspaces = workspaces.filter(isRestartableAutomaticWorkspace);
    const started: RestartAutomaticWorkspacesResult["started"] = [];
    const failures: RestartAutomaticWorkspacesResult["failures"] = [];

    for (const workspace of automaticWorkspaces) {
      const executionHost = (
        workspace.provisioningHostBinding ?? workspace.executionHostBinding
      ).host;
      try {
        const snapshot = await provisioningManager.startJob({
          name: workspace.name,
          executionHost,
          repoUrl: workspace.repoUrl ?? "",
          basePath: workspace.basePath ?? "",
          devcontainerSubpath: workspace.devcontainerSubpath ?? undefined,
          provider: workspace.serverSettings.agent.provider,
          adapter: workspace.serverSettings.agent.adapter,
          mode: "restart",
          targetDirectory: workspace.sourceDirectory.trim(),
          workspaceId: workspace.id,
        });
        started.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          provisioningJobId: snapshot.job.config.id,
        });
      } catch (error) {
        const message = isDomainError(error)
          ? error.message
          : "Failed to start the workspace restart job.";
        if (isDomainError(error)) {
          log.warn("Unable to start automatic workspace restart", {
            workspaceId: workspace.id,
            code: error.code,
            error: message,
          });
        } else {
          log.error("Unexpected failure starting automatic workspace restart", {
            workspaceId: workspace.id,
            error: String(error),
          });
        }
        failures.push({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          error: message,
        });
      }
    }

    log.info("Automatic workspace restart jobs submitted", {
      totalWorkspaces: automaticWorkspaces.length,
      startedCount: started.length,
      failureCount: failures.length,
    });
    return {
      totalWorkspaces: automaticWorkspaces.length,
      started,
      failures,
    };
  }
}

export const settingsMaintenanceService = new SettingsMaintenanceService();
