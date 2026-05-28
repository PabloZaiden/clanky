/**
 * Library exports for Clanky frontend.
 */

export {
  log,
  createLogger,
  setLogLevel,
  getLogLevel,
  LOG_LEVELS,
  LOG_LEVEL_NAMES,
  LOG_LEVEL_OPTIONS,
  DEFAULT_LOG_LEVEL,
  type LogLevelName,
} from "./logger";
export {
  clearStoredSshServerCredential,
  encryptSshServerPassword,
  exchangeSshServerCredential,
  fetchSshServerPublicKey,
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
  invalidateStoredSshCredentialToken,
  isStoredCredentialCompatible,
  saveStoredSshServerCredential,
  storeSshServerPassword,
  type BrowserCredentialStorageLike,
  type StoredSshServerCredential,
  type SshBrowserCredentialDependencies,
} from "./ssh-browser-credentials";
export {
  getStoredChatModelPreference,
  getStoredTaskCheapModelPreference,
  getStoredTaskModelPreference,
  saveStoredChatModelPreference,
  saveStoredTaskCheapModelPreference,
  saveStoredTaskModelPreference,
  type ModelPreferenceStorageLike,
  type ModelSelectionPreferenceDependencies,
} from "./model-selection-preferences";
export {
  applyThemeSnapshotToDocument,
  DEFAULT_THEME_PREFERENCE,
  getStoredThemePreference,
  getSystemPrefersDark,
  getThemeSnapshot,
  isResolvedTheme,
  isThemePreference,
  resolveThemePreference,
  saveStoredThemePreference,
  THEME_DARK_CLASS,
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  type ThemeStorageLike,
  type ThemeSnapshot,
} from "./theme";
export {
  clearStoredVncPassword,
  getStoredVncCredentials,
  getStoredVncCredentialsRecord,
  getStoredVncPassword,
  getStoredVncPasswordRecord,
  storeVncCredentials,
  storeVncPassword,
  type EncryptedVncPassword,
  type StoredVncCredentials,
  type StoredVncCredentialsResult,
  type StoredVncPassword,
  type VncBrowserCredentialDependencies,
  type VncCredentials,
  type VncCredentialStorageLike,
} from "./vnc-browser-credentials";
