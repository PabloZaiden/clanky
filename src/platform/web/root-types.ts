import type {
  SettingsRow as CoreSettingsRow,
  SettingsSection as CoreSettingsSection,
  WebAppRootProps as CoreWebAppRootProps,
} from "@pablozaiden/webapp/web";

export type { SettingsAction } from "@pablozaiden/webapp/web";

export type SettingsScope = "user" | "admin" | "owner";
export type SettingsRow = CoreSettingsRow & { scope?: SettingsScope };
export type SettingsSection = Omit<CoreSettingsSection, "rows"> & {
  scope?: SettingsScope;
  rows?: SettingsRow[];
};
export type WebAppRootProps = Omit<CoreWebAppRootProps, "settings"> & {
  settings?: { sections?: SettingsSection[] };
};
