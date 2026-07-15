import type { WebAppRootProps } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "@/shared/preferences";
import {
  PurgeTerminalTasksAction,
  QuickChatModelRowContent,
  SchedulerTimezoneRowContent,
  SettingsCheckbox,
  SettingsError,
  SettingsSelect,
} from "../app-settings";
import type {
  PrivateItemsPreference,
  UseDashboardDataResult,
  UseFileExplorerFullTreePreferenceResult,
  UseMarkdownPreferenceResult,
  UseQuickChatSettingsResult,
  UseSchedulerTimezoneResult,
} from "../../hooks";

export interface ShellSettingsCompositionOptions {
  quickChatSettings: UseQuickChatSettingsResult;
  schedulerTimezone: UseSchedulerTimezoneResult;
  markdownPreference: UseMarkdownPreferenceResult;
  fullTreePreference: UseFileExplorerFullTreePreferenceResult;
  privateItemsPreference: PrivateItemsPreference;
  dashboardData: Pick<
    UseDashboardDataResult,
    "purgeTerminalTasks" | "appSettingsPurgingTerminalTasks"
  >;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  refreshTasks: () => Promise<void>;
}

export type ShellSettingsSections =
  NonNullable<NonNullable<WebAppRootProps["settings"]>["sections"]>;

export function buildShellSettingsSections({
  quickChatSettings,
  schedulerTimezone,
  markdownPreference,
  fullTreePreference,
  privateItemsPreference,
  dashboardData,
  workspaces,
  workspacesLoading,
  refreshTasks,
}: ShellSettingsCompositionOptions): ShellSettingsSections {
  const selectedQuickChatWorkspace = workspaces.find(
    (workspace) => workspace.id === quickChatSettings.settings.workspaceId,
  ) ?? null;

  return [
    {
      id: "quick-chat",
      title: "Quick Chat",
      scope: "user" as const,
      description: "Configure the defaults used by the Quick Chat shortcut.",
      rows: [
        {
          id: "quick-chat-workspace",
          title: "Workspace",
          content: (
            <div className="space-y-2">
              <SettingsSelect
                id="quick-chat-workspace"
                aria-label="Quick Chat workspace"
                value={quickChatSettings.settings.workspaceId}
                onChange={(event) => void quickChatSettings.updateSettings({
                  workspaceId: event.currentTarget.value,
                  model: null,
                  useWorktree: quickChatSettings.settings.useWorktree,
                })}
                disabled={quickChatSettings.loading || quickChatSettings.saving || workspacesLoading}
              >
                <option value="">
                  {workspacesLoading ? "Loading workspaces..." : "No quick chat workspace"}
                </option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </SettingsSelect>
              {quickChatSettings.error ? <SettingsError>{quickChatSettings.error}</SettingsError> : null}
            </div>
          ),
        },
        {
          id: "quick-chat-model",
          title: "Model",
          content: (
            <QuickChatModelRowContent
              workspace={selectedQuickChatWorkspace}
              settings={quickChatSettings.settings}
              loading={quickChatSettings.loading}
              saving={quickChatSettings.saving}
              onUpdate={quickChatSettings.updateSettings}
            />
          ),
        },
        {
          id: "quick-chat-worktree",
          title: "Use worktrees for quick chats",
          content: (
            <SettingsCheckbox
              id="quick-chat-worktree"
              ariaLabel="Use worktrees for quick chats"
              checked={quickChatSettings.settings.useWorktree}
              onChange={(event) => void quickChatSettings.updateSettings({
                workspaceId: quickChatSettings.settings.workspaceId,
                model: quickChatSettings.settings.model,
                useWorktree: event.currentTarget.checked,
              })}
              disabled={quickChatSettings.loading || quickChatSettings.saving}
            />
          ),
          contentPlacement: "inline",
        },
        {
          id: "quick-chat-clear",
          title: "Reset Quick Chat",
          actions: [{
            id: "clear-quick-chat",
            label: "Clear",
            variant: "ghost" as const,
            disabled: quickChatSettings.loading
              || quickChatSettings.saving
              || (!quickChatSettings.settings.workspaceId
                && !quickChatSettings.settings.model
                && !quickChatSettings.settings.useWorktree),
            onAction: () => {
              void quickChatSettings.updateSettings(DEFAULT_QUICK_CHAT_SETTINGS);
            },
          }],
        },
      ],
    },
    {
      id: "agents",
      title: "Agents",
      scope: "user" as const,
      description: "Configure Clanky-specific agent defaults.",
      rows: [{
        id: "scheduler-timezone",
        title: "Timezone",
        content: (
          <SchedulerTimezoneRowContent
            timezone={schedulerTimezone.timezone}
            loading={schedulerTimezone.loading}
            saving={schedulerTimezone.saving}
            error={schedulerTimezone.error}
            onUpdate={schedulerTimezone.updateTimezone}
          />
        ),
      }],
    },
    {
      id: "private-items",
      title: "Private items",
      scope: "user" as const,
      description: "Control whether this browser shows or obscures items marked private.",
      rows: [{
        id: "show-private-items",
        title: "Show private items",
        content: (
          <SettingsCheckbox
            id="show-private-items"
            ariaLabel="Show private items"
            checked={privateItemsPreference.showPrivateItems}
            onChange={(event) => privateItemsPreference.setShowPrivateItems(event.currentTarget.checked)}
          />
        ),
        contentPlacement: "inline",
      }],
    },
    {
      id: "content",
      title: "Content",
      scope: "user" as const,
      description: "Configure Clanky-specific content rendering and file explorer behavior.",
      rows: [
        {
          id: "markdown-rendering",
          title: "Render markdown",
          content: (
            <SettingsCheckbox
              id="markdown-rendering"
              ariaLabel="Render markdown"
              checked={markdownPreference.enabled}
              disabled={markdownPreference.loading || markdownPreference.saving}
              error={markdownPreference.error}
              onChange={(event) => void markdownPreference.setEnabled(event.currentTarget.checked)}
            />
          ),
          contentPlacement: "inline",
        },
        {
          id: "file-explorer-full-tree",
          title: "Load full file tree",
          content: (
            <SettingsCheckbox
              id="file-explorer-full-tree"
              ariaLabel="Load full file tree"
              checked={fullTreePreference.enabled}
              disabled={fullTreePreference.loading || fullTreePreference.saving}
              error={fullTreePreference.error}
              onChange={(event) => void fullTreePreference.setEnabled(event.currentTarget.checked)}
            />
          ),
          contentPlacement: "inline",
        },
      ],
    },
    {
      id: "clanky-danger-zone",
      title: "Maintenance",
      scope: "owner" as const,
      description: "Clanky-specific maintenance operations. Framework server operations live in the standard settings sections.",
      rows: [{
        id: "purge-terminal-tasks",
        title: "Purge terminal-state tasks",
        description: "Permanently delete archived terminal tasks across every workspace. Addressable pushed and accepted-local tasks are kept.",
        danger: true,
        actions: (
          <PurgeTerminalTasksAction
            onPurgeTerminalTasks={async () => {
              const result = await dashboardData.purgeTerminalTasks();
              if (result) {
                await refreshTasks();
              }
              return result;
            }}
            purgingTerminalTasks={dashboardData.appSettingsPurgingTerminalTasks}
          />
        ),
      }],
    },
  ];
}
