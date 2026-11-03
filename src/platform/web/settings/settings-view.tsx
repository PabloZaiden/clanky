import { useEffect, useState } from "react";
import type { WebAppConfigResponse } from "../../contracts";
import { clientScopedStorageKey } from "../client-session";
import { FormSection } from "@pablozaiden/webapp/web";
import type { SettingsScope, SettingsSection } from "../root-types";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import { readStorage, warnStorageIssue, writeStorage } from "../storage";
import { AccountSection } from "./account-section";
import { SecuritySection } from "./security-section";
import { SessionsSection } from "./sessions-section";
import { ShutdownSection } from "./shutdown-section";
import { UserManagement } from "./user-management";
import { SettingsSectionContent } from "@pablozaiden/webapp/web";
import { SettingsLayout } from "@pablozaiden/webapp/web";
import { RemoteClientSettings } from "../remote-client";
import { AppearanceSection } from "./appearance-section";
import type { WebAppExternalSession } from "@pablozaiden/webapp/web";

export type { SettingsAction, SettingsRow, SettingsSection } from "../root-types";

function isScopeVisible(scope: SettingsScope | undefined, config: WebAppConfigResponse | undefined, external?: WebAppExternalSession): boolean {
  if (external) return !scope || scope === "user";
  if (!config) return false;
  if (!scope || scope === "user") return Boolean(config.currentUser);
  return scope === "admin" ? Boolean(config.currentUser?.isAdmin) : Boolean(config.currentUser?.isOwner);
}

export interface SettingsViewProps {
  config?: WebAppConfigResponse;
  external?: WebAppExternalSession;
  appName?: string;
  version?: string;
  refresh: () => Promise<void>;
  customSections: SettingsSection[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
}

export function SettingsView({ config, external, appName, version, refresh, customSections, route, navigate }: SettingsViewProps) {
  const [error, setError] = useState<string>();
  const visibleSections = customSections.filter((section) => isScopeVisible(section.scope, config, external)).map((section) => ({
    ...section,
    rows: section.rows?.filter((row) => isScopeVisible(row.scope, config, external)),
  }));
  const categories = new Map<string, string>([["general", "General"]]);
  if (config) categories.set("account", "Account & access");
  for (const section of visibleSections) {
    if (section.category) categories.set(section.category.id, section.category.title);
  }
  if (config?.currentUser?.isAdmin) {
    categories.set("administration", "Administration");
    categories.set("maintenance", "Maintenance");
  }
  categories.set("about", "About");
  const storageKey = clientScopedStorageKey(`webapp.${(appName ?? config?.appName ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.settings.category`);
  const [rememberedCategory, setRememberedCategory] = useState(() => {
    const result = readStorage(storageKey);
    if (!result.ok || result.value === null) return "general";
    if (categories.has(result.value)) return result.value;
    warnStorageIssue(storageKey, "invalid-value");
    return "general";
  });
  const requested = route["category"] ?? rememberedCategory;
  const selected = categories.has(requested) ? requested : "general";
  useEffect(() => {
    setRememberedCategory(selected);
    writeStorage(storageKey, selected);
  }, [selected, storageKey]);
  function select(category: string) {
    setError(undefined);
    navigate({ view: "settings", category });
  }
  return (
    <SettingsLayout categories={Array.from(categories, ([id, title]) => ({ id, title }))} category={selected} onCategoryChange={select}>
      <div key={selected}>
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
        {selected === "general" ? <RemoteClientSettings /> : null}
        {selected === "general" && external ? <AppearanceSection setError={setError} /> : null}
        {config && ["general", "account", "administration"].includes(selected) ? <AccountSection config={config} refresh={refresh} setError={setError} category={selected} /> : null}
        {selected === "account" && config ? <FormSection title="Security">
          <SecuritySection config={config} refresh={refresh} setError={setError} />
          <SessionsSection config={config} setError={setError} />
        </FormSection> : null}
        {selected === "administration" && config ? <UserManagement config={config} /> : null}
        {visibleSections.filter((section) => (section.category?.id ?? "general") === selected).map((section) => <SettingsSectionContent key={section.id} section={section} />)}
        {selected === "maintenance" && config ? <ShutdownSection config={config} setError={setError} /> : null}
        {selected === "about" ? <FormSection title="Version"><span>{appName ?? config?.appName} {version ?? config?.version}</span></FormSection> : null}
      </div>
    </SettingsLayout>
  );
}
