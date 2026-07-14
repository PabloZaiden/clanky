/**
 * Core user-preference operations.
 *
 * Persistence stores the values; this service owns cross-domain validation
 * such as ensuring quick-chat workspaces belong to the current user.
 */

import {
  getDashboardViewMode as getDashboardViewModeRecord,
  getFileExplorerFullTreeEnabled as getFileExplorerFullTreeEnabledRecord,
  getLastCheapModel as getLastCheapModelRecord,
  getLastDirectory as getLastDirectoryRecord,
  getLastModel as getLastModelRecord,
  getMarkdownRenderingEnabled as getMarkdownRenderingEnabledRecord,
  getQuickChatSettings as getQuickChatSettingsRecord,
  getSchedulerTimezone as getSchedulerTimezoneRecord,
  setDashboardViewMode as setDashboardViewModeRecord,
  setFileExplorerFullTreeEnabled as setFileExplorerFullTreeEnabledRecord,
  setLastCheapModel as setLastCheapModelRecord,
  setLastDirectory as setLastDirectoryRecord,
  setLastModel as setLastModelRecord,
  setMarkdownRenderingEnabled as setMarkdownRenderingEnabledRecord,
  setQuickChatSettings as setQuickChatSettingsRecord,
  setSchedulerTimezone as setSchedulerTimezoneRecord,
} from "../persistence/preferences";
import type { CheapModelSelection } from "@/contracts/schemas/model";
import type { DashboardViewMode, QuickChatSettings } from "@/shared/preferences";
import { DomainError } from "./domain-error";
import { workspaceManager } from "./workspace-manager";

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
      const workspace = await workspaceManager.getWorkspace(settings.workspaceId);
      if (!workspace) {
        throw new DomainError(
          "workspace_not_found",
          "Quick chat workspace does not exist",
          { details: { workspaceId: settings.workspaceId } },
        );
      }
    }
    await setQuickChatSettingsRecord(settings);
  }

  async validateQuickChatModel(request: QuickChatModelRequest): Promise<void> {
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

  async getSchedulerTimezone(): Promise<string> {
    return await getSchedulerTimezoneRecord();
  }

  async setSchedulerTimezone(timezone: string): Promise<void> {
    await setSchedulerTimezoneRecord(timezone);
  }
}

export const preferencesManager = new PreferencesManager();
