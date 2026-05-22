/**
 * AppSettingsPanel and AppSettingsModal assembled from focused sub-components.
 */

import { Button, Modal } from "../common";
import type { PasskeyAuthStatusResponse } from "../../types/api";
import type { PublicWorkspace } from "../../types/workspace";
import type { QuickChatSettings } from "../../types/preferences";
import { DEFAULT_QUICK_CHAT_SETTINGS } from "../../types/preferences";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";
import type { PurgeTerminalTasksResult } from "../../hooks";
import { DisplaySettingsSection } from "./display-settings-section";
import { DeveloperSettingsSection } from "./developer-settings-section";
import { ImportExportSection } from "./import-export-section";
import { DangerZoneSection } from "./danger-zone-section";
import { PasskeyAuthSection } from "./passkey-auth-section";
import { TokenAuthSection } from "./token-auth-section";
import { QuickChatSettingsSection } from "./quick-chat-settings-section";

export interface AppSettingsPanelProps {
  /** Callback to reset all settings (destructive - deletes database) */
  onResetAll?: () => Promise<boolean>;
  /** Whether resetting all is in progress */
  resetting?: boolean;
  /** Callback to kill the server (for container restart) */
  onKillServer?: () => Promise<boolean>;
  /** Whether kill server is in progress */
  killingServer?: boolean;
  /** Callback to purge terminal-state tasks across all workspaces */
  onPurgeTerminalTasks?: () => Promise<PurgeTerminalTasksResult | null>;
  /** Whether global terminal-state purge is in progress */
  purgingTerminalTasks?: boolean;
  /** Callback to export workspace configs */
  onExportConfig?: () => Promise<WorkspaceExportData | null>;
  /** Callback to import workspace configs */
  onImportConfig?: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;
  /** Whether an export/import operation is in progress */
  configSaving?: boolean;
  /** Current passkey-auth status for this browser */
  passkeyAuthStatus?: PasskeyAuthStatusResponse;
  /** Whether passkey registration is in progress */
  registeringPasskey?: boolean;
  /** Whether passkey logout is in progress */
  loggingOutPasskey?: boolean;
  /** Whether passkey removal is in progress */
  removingPasskey?: boolean;
  /** Whether passkey status is refreshing */
  refreshingPasskeyAuth?: boolean;
  /** Workspaces available for quick chat configuration */
  workspaces?: PublicWorkspace[];
  /** Whether workspaces are loading */
  workspacesLoading?: boolean;
  /** Current quick chat settings */
  quickChatSettings?: QuickChatSettings;
  /** Whether quick chat settings are loading */
  quickChatSettingsLoading?: boolean;
  /** Whether quick chat settings are saving */
  quickChatSettingsSaving?: boolean;
  /** Quick chat settings error */
  quickChatSettingsError?: string | null;
  /** Callback to update quick chat settings */
  onUpdateQuickChatSettings?: (settings: QuickChatSettings) => Promise<QuickChatSettings | null>;
  /** Callback to register a passkey */
  onRegisterPasskey?: (name?: string) => Promise<boolean>;
  /** Callback to log out the current browser passkey session */
  onLogoutPasskey?: () => Promise<boolean>;
  /** Callback to remove the configured passkey */
  onRemovePasskey?: () => Promise<boolean>;
}

export interface AppSettingsModalProps extends AppSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * AppSettingsPanel provides the shell-native UI for global app settings.
 */
export function AppSettingsPanel({
  onResetAll,
  resetting = false,
  onKillServer,
  killingServer = false,
  onPurgeTerminalTasks,
  purgingTerminalTasks = false,
  onExportConfig,
  onImportConfig,
  configSaving = false,
  passkeyAuthStatus,
  registeringPasskey = false,
  loggingOutPasskey = false,
  removingPasskey = false,
  refreshingPasskeyAuth = false,
  workspaces = [],
  workspacesLoading = false,
  quickChatSettings = DEFAULT_QUICK_CHAT_SETTINGS,
  quickChatSettingsLoading = false,
  quickChatSettingsSaving = false,
  quickChatSettingsError = null,
  onUpdateQuickChatSettings,
  onRegisterPasskey,
  onLogoutPasskey,
  onRemovePasskey,
}: AppSettingsPanelProps) {
  return (
    <div className="space-y-6">
      <DisplaySettingsSection />
      {onUpdateQuickChatSettings ? (
        <QuickChatSettingsSection
          workspaces={workspaces}
          workspacesLoading={workspacesLoading}
          settings={quickChatSettings}
          loading={quickChatSettingsLoading}
          saving={quickChatSettingsSaving}
          error={quickChatSettingsError}
          onUpdate={onUpdateQuickChatSettings}
        />
      ) : null}
      <DeveloperSettingsSection />
      {passkeyAuthStatus ? (
        <PasskeyAuthSection
          status={passkeyAuthStatus}
          registering={registeringPasskey}
          loggingOut={loggingOutPasskey}
          removingPasskey={removingPasskey}
          refreshing={refreshingPasskeyAuth}
          onRegisterPasskey={onRegisterPasskey}
          onLogout={onLogoutPasskey}
        />
      ) : null}
      <TokenAuthSection />
      <ImportExportSection
        onExportConfig={onExportConfig}
        onImportConfig={onImportConfig}
        configSaving={configSaving}
      />
      <DangerZoneSection
        onResetAll={onResetAll}
        resetting={resetting}
        onKillServer={onKillServer}
        killingServer={killingServer}
        onPurgeTerminalTasks={onPurgeTerminalTasks}
        purgingTerminalTasks={purgingTerminalTasks}
        passkeyConfigured={passkeyAuthStatus?.passkeyConfigured}
        removingPasskey={removingPasskey}
        onRemovePasskey={onRemovePasskey}
      />
    </div>
  );
}

export function AppSettingsModal({
  isOpen,
  onClose,
  ...props
}: AppSettingsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="App Settings"
      description="Configure global app preferences"
      size="md"
      footer={(
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      )}
    >
      <AppSettingsPanel {...props} />
    </Modal>
  );
}

export default AppSettingsPanel;
