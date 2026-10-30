import type { WebAppRootProps, WebAppRoute } from "@pablozaiden/webapp/web";
import type { Workspace } from "@/shared";
import { getWorkspaceDisplayName } from "../../lib/workspace-label";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "@/shared/preferences";
import {
  PurgeTerminalTasksAction,
  WorkerUpdateAction,
  QuickChatModelRowContent,
  WorkersSettingsSection,
  ControllerSettingsContent,
  RelaySettingsContent,
  SchedulerTimezoneRowContent,
  GithubUsernameRowContent,
  SettingsCheckbox,
  SettingsError,
  SettingsSelect,
  VoiceSettingsRowContent,
  PromptTemplatesSettingsContent,
} from "../app-settings";
import type {
  PrivateItemsPreference,
  UseDashboardDataResult,
  UseFileExplorerFullTreePreferenceResult,
  UseGithubUsernameResult,
  UseMarkdownPreferenceResult,
  UseMeshResult,
  UseQuickChatSettingsResult,
  UseSchedulerTimezoneResult,
  UseVoiceSettingsResult,
} from "../../hooks";
import type { UseWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import { WorkspaceCollaborationContent } from "../app-settings/workspace-collaboration-content";
import { ControlCredentialsContent } from "../app-settings/control-credentials-content";
import { ControlOAuthGrantsContent } from "../app-settings/control-oauth-grants-content";
import { getClankyClientCapabilities } from "../../client-sdk/capabilities";
import { ControlApprovalPolicyContent } from "../app-settings/control-approval-policy-content";
import { PendingControlRequests } from "../control/control-requests";
import { NotificationSettingsContent } from "../app-settings/notification-settings-content";

export interface ShellSettingsCompositionOptions {
  onNavigate: (route: WebAppRoute) => void;
  quickChatSettings: UseQuickChatSettingsResult;
  schedulerTimezone: UseSchedulerTimezoneResult;
  githubUsername: UseGithubUsernameResult;
  markdownPreference: UseMarkdownPreferenceResult;
  fullTreePreference: UseFileExplorerFullTreePreferenceResult;
  privateItemsPreference: PrivateItemsPreference;
  dashboardData: Pick<
    UseDashboardDataResult,
    | "purgeTerminalTasks"
    | "appSettingsPurgingTerminalTasks"
  >;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  refreshTasks: () => Promise<void>;
  mesh: UseMeshResult;
  workerUpdates: UseWorkerUpdateJobsResult;
  voiceSettings: UseVoiceSettingsResult;
}

export type ShellSettingsSections =
  NonNullable<NonNullable<WebAppRootProps["settings"]>["sections"]>;

export function buildShellSettingsSections({
  onNavigate,
  quickChatSettings,
  schedulerTimezone,
  githubUsername,
  markdownPreference,
  fullTreePreference,
  privateItemsPreference,
  dashboardData,
  workspaces,
  workspacesLoading,
  refreshTasks,
  mesh,
  workerUpdates,
  voiceSettings,
}: ShellSettingsCompositionOptions): ShellSettingsSections {
  const selectedQuickChatWorkspace = workspaces.find(
    (workspace) => workspace.id === quickChatSettings.settings.workspaceId,
  ) ?? null;
  const sections: ShellSettingsSections = [
    {
      id: "agent-notifications",
      title: "Notifications",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      rows: [{
        id: "notification-webhook",
        title: "Listen webhook URL",
        description: "Agents notify only when you explicitly ask. The saved URL is never shown to agents.",
        labelFor: "notification-webhook-url",
        content: <NotificationSettingsContent />,
      }],
    },
    {
      id: "control-approvals",
      title: "Approvals",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      rows: [{
        id: "require-control-approval",
        title: "Require approval for agent operations",
        description: "Voice always requires confirmation. Changing this does not approve pending requests.",
        labelFor: "require-control-approval",
        content: <ControlApprovalPolicyContent />,
        contentPlacement: "inline",
      }],
      // Pending requests need a collection with private reveal and individual decision links.
      render: () => <PendingControlRequests onNavigate={onNavigate} showPrivateItems={privateItemsPreference.showPrivateItems} />,
    },
    {
      id: "control-oauth-grants",
      title: "Authorized integrations",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      // Grant summaries need a collection with individual guarded revocation.
      render: () => <ControlOAuthGrantsContent />,
    },
    {
      id: "control-credentials",
      title: "Control service credentials",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      // Creation spans a grant form, a private one-time token and per-credential revocation.
      render: () => <ControlCredentialsContent />,
    },
    {
      id: "collaboration",
      title: "Collaboration",
      category: { id: "collaboration", title: "Collaboration" },
      scope: "user" as const,
      // Pairing spans workspace selection, one-use tokens and per-workspace grant retirement.
      render: () => <WorkspaceCollaborationContent workspaces={workspaces} />,
    },
    {
      id: "quick-chat",
      title: "Quick Chat",
      category: { id: "chats", title: "Chats" },
      scope: "user" as const,
      rows: [
        {
          id: "quick-chat-workspace",
          title: "Workspace",
          labelFor: "quick-chat-workspace",
          content: (
            <div className="space-y-2">
              <SettingsSelect
                id="quick-chat-workspace"
                aria-label="Quick Chat workspace"
                value={quickChatSettings.settings.workspaceId}
                onChange={(event) => void quickChatSettings.updateSettings({
                  workspaceId: event.currentTarget.value,
                  model: null,
                  useWorktree: workspaces.find(
                    (workspace) => workspace.id === event.currentTarget.value,
                  )?.workspaceType === "git"
                    && workspaces.find(
                      (workspace) => workspace.id === event.currentTarget.value,
                    )?.allowWorktrees !== false
                    ? quickChatSettings.settings.useWorktree
                    : false,
                })}
                disabled={quickChatSettings.loading || quickChatSettings.saving || workspacesLoading}
              >
                <option value="">
                  {workspacesLoading ? "Loading workspaces..." : "No quick chat workspace"}
                </option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {getWorkspaceDisplayName(workspace)}
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
          labelFor: "quick-chat-model",
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
        ...(selectedQuickChatWorkspace?.workspaceType === "git" ? [{
          id: "quick-chat-worktree",
          title: "Use worktrees for quick chats",
          labelFor: "quick-chat-worktree",
          content: (
            <SettingsCheckbox
              id="quick-chat-worktree"
              ariaLabel="Use worktrees for quick chats"
              checked={
                selectedQuickChatWorkspace.allowWorktrees !== false
                  && quickChatSettings.settings.useWorktree
              }
              onChange={(event) => void quickChatSettings.updateSettings({
                workspaceId: quickChatSettings.settings.workspaceId,
                model: quickChatSettings.settings.model,
                useWorktree: event.currentTarget.checked,
              })}
              disabled={
                quickChatSettings.loading
                || quickChatSettings.saving
                || selectedQuickChatWorkspace.allowWorktrees === false
              }
            />
          ),
          contentPlacement: "inline" as const,
        }] : []),
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
            onAction: async () => { await quickChatSettings.updateSettings(DEFAULT_QUICK_CHAT_SETTINGS); },
          }],
        },
      ],
    },
    {
      id: "mesh",
      title: "Workers",
      category: { id: "workers", title: "Workers" },
      scope: "owner" as const,
      // Worker lifecycle and enrollment need a list plus focused domain dialogs.
      render: () => <WorkersSettingsSection mesh={mesh} />,
    },
    {
      id: "controller",
      title: "Controller",
      category: { id: "controller", title: "Controller" },
      scope: "owner" as const,
      // Identity has a shared guarded draft and runtime protocol metadata.
      render: () => <ControllerSettingsContent mesh={mesh} />,
    },
    {
      id: "relays",
      title: "Relays",
      category: { id: "relays", title: "Relays" },
      scope: "owner" as const,
      // Pairing needs generated bootstrap configuration and runtime health.
      render: () => <RelaySettingsContent />,
    },
    {
      id: "voice",
      title: "Voice",
      category: { id: "voice", title: "Voice" },
      scope: "user" as const,
      // One shared draft and submit spans provider, models and credentials.
      render: () => <VoiceSettingsRowContent voiceSettings={voiceSettings} />,
    },
    {
      id: "agents",
      title: "Agents",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      rows: [{
        id: "scheduler-timezone",
        title: "Timezone",
        labelFor: "scheduler-timezone",
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
      id: "github",
      title: "GitHub",
      category: { id: "integrations", title: "Agents & integrations" },
      scope: "user" as const,
      rows: [{
        id: "github-username",
        title: "Username",
        labelFor: "github-username",
        content: (
          <GithubUsernameRowContent
            githubUsername={githubUsername.githubUsername}
            loading={githubUsername.loading}
            saving={githubUsername.saving}
            error={githubUsername.error}
            onUpdate={githubUsername.updateGithubUsername}
          />
        ),
      }],
    },
    {
      id: "prompt-templates",
      title: "Templates",
      category: { id: "content", title: "Content" },
      scope: "user" as const,
      // The row model cannot represent a collection with per-item editing and ordering.
      render: () => <PromptTemplatesSettingsContent />,
    },
    {
      id: "private-items",
      title: "Private items",
      scope: "user" as const,
      rows: [{
        id: "show-private-items",
        title: "Show private items",
        labelFor: "show-private-items",
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
      rows: [
        {
          id: "markdown-rendering",
          title: "Render markdown",
          labelFor: "markdown-rendering",
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
          labelFor: "file-explorer-full-tree",
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
      category: { id: "maintenance", title: "Maintenance" },
      scope: "owner" as const,
      // Domain actions own async confirmation/results, using shared field rows.
      render: () => <>
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
            <WorkerUpdateAction workerUpdates={workerUpdates} />
      </>,
    },
  ];
  const capabilities = getClankyClientCapabilities();
  const controllerSections = new Set(["mesh", "controller", "relays", "agents", "github", "agent-notifications", "control-approvals", "control-oauth-grants", "control-credentials", "clanky-danger-zone"]);
  return sections.filter((section) => section.id === "voice"
    ? capabilities.voice
    : capabilities.controllerAdministration || !controllerSections.has(section.id));
}
