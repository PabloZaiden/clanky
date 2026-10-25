/**
 * Core user-preference operations.
 *
 * Persistence stores the values; this service owns cross-domain validation
 * such as ensuring quick-chat workspaces belong to the current user.
 */

import {
  getDashboardViewMode as getDashboardViewModeRecord,
  getFileExplorerFullTreeEnabled as getFileExplorerFullTreeEnabledRecord,
  getGithubUsername as getGithubUsernameRecord,
  getLastCheapModel as getLastCheapModelRecord,
  getLastDirectory as getLastDirectoryRecord,
  getLastModel as getLastModelRecord,
  getMarkdownRenderingEnabled as getMarkdownRenderingEnabledRecord,
  getPromptTemplates as getPromptTemplatesRecord,
  getQuickChatSettings as getQuickChatSettingsRecord,
  getSchedulerTimezone as getSchedulerTimezoneRecord,
  setDashboardViewMode as setDashboardViewModeRecord,
  setFileExplorerFullTreeEnabled as setFileExplorerFullTreeEnabledRecord,
  setGithubUsername as setGithubUsernameRecord,
  setLastCheapModel as setLastCheapModelRecord,
  setLastDirectory as setLastDirectoryRecord,
  setLastModel as setLastModelRecord,
  setMarkdownRenderingEnabled as setMarkdownRenderingEnabledRecord,
  setPromptTemplates as setPromptTemplatesRecord,
  setQuickChatSettings as setQuickChatSettingsRecord,
  setSchedulerTimezone as setSchedulerTimezoneRecord,
} from "../persistence/preferences";
import type { CheapModelSelection } from "@/contracts/schemas/model";
import type { PromptTemplate } from "@/shared/prompt-templates";
import type { DashboardViewMode, QuickChatSettings } from "@/shared/preferences";
import { DomainError } from "../domain/domain-error";
import { workspaceManager } from "./workspace-manager";
import { workspaceConnections } from "./workspace-connections";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { getCollaborationActor, requireResourceOwnerUserId } from "../context/user-context";

export interface LastModelPreference {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface QuickChatModelRequest {
  workspaceId: string;
  model: {
    providerID: string;
    modelID: string;
    variant?: string;
  };
}

export class PreferencesManager {
  async getLastModel(): Promise<LastModelPreference | undefined> {
    return await getLastModelRecord();
  }

  async setLastModel(model: LastModelPreference): Promise<void> {
    await setLastModelRecord(model);
  }

  async getLastCheapModel(): Promise<CheapModelSelection | undefined> {
    return await getLastCheapModelRecord();
  }

  async setLastCheapModel(selection: CheapModelSelection): Promise<void> {
    await setLastCheapModelRecord(selection);
  }

  async getLastDirectory(): Promise<string | undefined> {
    return await getLastDirectoryRecord();
  }

  async setLastDirectory(directory: string): Promise<void> {
    await setLastDirectoryRecord(directory);
  }

  async getGithubUsername(): Promise<string | undefined> {
    return await getGithubUsernameRecord();
  }

  async setGithubUsername(username: string): Promise<void> {
    await setGithubUsernameRecord(username);
  }

  async getMarkdownRenderingEnabled(): Promise<boolean> {
    return await getMarkdownRenderingEnabledRecord();
  }

  async setMarkdownRenderingEnabled(enabled: boolean): Promise<void> {
    await setMarkdownRenderingEnabledRecord(enabled);
  }

  async getFileExplorerFullTreeEnabled(): Promise<boolean> {
    return await getFileExplorerFullTreeEnabledRecord();
  }

  async setFileExplorerFullTreeEnabled(enabled: boolean): Promise<void> {
    await setFileExplorerFullTreeEnabledRecord(enabled);
  }

  async getDashboardViewMode(): Promise<DashboardViewMode> {
    return await getDashboardViewModeRecord();
  }

  async setDashboardViewMode(mode: DashboardViewMode): Promise<void> {
    await setDashboardViewModeRecord(mode);
  }

  async getQuickChatSettings(): Promise<QuickChatSettings> {
    return await getQuickChatSettingsRecord();
  }

  async setQuickChatSettings(settings: QuickChatSettings): Promise<void> {
    if (settings.workspaceId) {
      const remote = decodeCollaborationResourceReference(settings.workspaceId);
      if (remote) {
        await workspaceConnections.requireWorkspaceReference(remote);
      } else if (!await workspaceManager.getWorkspace(settings.workspaceId)) {
        throw new DomainError(
          "workspace_not_found",
          "Quick chat workspace does not exist",
          { details: { workspaceId: settings.workspaceId } },
        );
      }
    }
    await setQuickChatSettingsRecord(settings);
  }

  async getPromptTemplates(): Promise<PromptTemplate[]> {
    return await getPromptTemplatesRecord();
  }

  async setPromptTemplates(templates: PromptTemplate[]): Promise<void> {
    await setPromptTemplatesRecord(templates);
  }

  async validateQuickChatModel(request: QuickChatModelRequest): Promise<void> {
    if (getCollaborationActor()?.kind === "guest") {
      // Personal preferences are validated by the guest's instance, not its controller.
      requireResourceOwnerUserId(request.workspaceId);
      return;
    }
    const settings = await this.getQuickChatSettings();
    const configuredModel = settings.model;
    if (
      settings.workspaceId !== request.workspaceId
      || !configuredModel
      || configuredModel.providerID !== request.model.providerID
      || configuredModel.modelID !== request.model.modelID
      || configuredModel.variant !== (request.model.variant ?? "")
    ) {
      throw new DomainError(
        "quick_chat_model_mismatch",
        "Quick chat requests must use the saved quick chat workspace and model settings",
      );
    }
  }

  async getSchedulerTimezone(workspaceId?: string): Promise<string> {
    if (workspaceId && !await workspaceManager.getWorkspace(workspaceId)) {
      throw new DomainError("workspace_not_found", "The scheduling workspace is unavailable.");
    }
    return await getSchedulerTimezoneRecord(workspaceId ? requireResourceOwnerUserId(workspaceId) : undefined);
  }

  async setSchedulerTimezone(timezone: string): Promise<void> {
    await setSchedulerTimezoneRecord(timezone);
  }
}

export const preferencesManager = new PreferencesManager();
