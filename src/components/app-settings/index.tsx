/**
 * AppSettingsPanel and AppSettingsModal assembled from focused sub-components.
 */

import { Button, Modal } from "../common";
import type { PasskeyAuthStatusResponse } from "../../types/api";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";
import { DisplaySettingsSection } from "./display-settings-section";
import { DeveloperSettingsSection } from "./developer-settings-section";
import { ImportExportSection } from "./import-export-section";
import { DangerZoneSection } from "./danger-zone-section";
import { PasskeyAuthSection } from "./passkey-auth-section";

export interface AppSettingsPanelProps {
  /** Callback to reset all settings (destructive - deletes database) */
  onResetAll?: () => Promise<boolean>;
  /** Whether resetting all is in progress */
  resetting?: boolean;
  /** Callback to kill the server (for container restart) */
  onKillServer?: () => Promise<boolean>;
  /** Whether kill server is in progress */
  killingServer?: boolean;
  /** Callback to export workspace configs */
  onExportConfig?: () => Promise<WorkspaceExportData | null>;
  /** Callback to import workspace configs */
  onImportConfig?: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;
  /** Whether an export/import operation is in progress */
  configSaving?: boolean;
  /** Current passkey-auth status for this browser */
  passkeyAuthStatus?: PasskeyAuthStatusResponse;
  /** Whether transport-level basic auth is also enabled */
  basicAuthEnabled?: boolean;
  /** Whether passkey registration is in progress */
  registeringPasskey?: boolean;
  /** Whether passkey logout is in progress */
  loggingOutPasskey?: boolean;
  /** Whether passkey removal is in progress */
  removingPasskey?: boolean;
  /** Whether passkey status is refreshing */
  refreshingPasskeyAuth?: boolean;
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
  onExportConfig,
  onImportConfig,
  configSaving = false,
  passkeyAuthStatus,
  basicAuthEnabled = false,
  registeringPasskey = false,
  loggingOutPasskey = false,
  removingPasskey = false,
  refreshingPasskeyAuth = false,
  onRegisterPasskey,
  onLogoutPasskey,
  onRemovePasskey,
}: AppSettingsPanelProps) {
  return (
    <div className="space-y-6">
      <DisplaySettingsSection />
      <DeveloperSettingsSection />
      {passkeyAuthStatus ? (
        <PasskeyAuthSection
          status={passkeyAuthStatus}
          basicAuthEnabled={basicAuthEnabled}
          registering={registeringPasskey}
          loggingOut={loggingOutPasskey}
          removingPasskey={removingPasskey}
          refreshing={refreshingPasskeyAuth}
          onRegisterPasskey={onRegisterPasskey}
          onLogout={onLogoutPasskey}
        />
      ) : null}
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
