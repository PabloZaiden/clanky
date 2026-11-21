import { Fragment, forwardRef, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Panel,
  ThemeProvider,
  WebAppRoot,
  replaceWebAppRoute,
  isThemePreference,
  setLogLevel,
  useRealtimeRefresh,
  type WebAppRootController,
} from "@pablozaiden/webapp/web";
import { appJson, appPagePath, getWebAppClientVersion } from "./api-client";
import { DeviceVerificationScreen, PasskeyAuthScreen, UserSetupScreen } from "./auth-screens";
import { getClientSession, invalidateClientSession } from "./client-session";
import { ServerAccountScreen } from "./server-account";
import { SettingsView } from "./settings/settings-view";
import type { WebAppRootProps } from "./root-types";
import { WebAppConfigProvider, useWebAppConfig } from "./webapp-config";
import type { ThemePreference } from "../contracts";
import { useSidebarPinProvider } from "@/hooks/useSidebarPinProvider";
import { AppearanceProvider } from "./appearance-context";
import { CLANKY_REALTIME_RESOURCES } from "@/shared/realtime";
import { PerformanceStatsPanel } from "./performance-stats-panel";

function pagePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function useAccountTheme() {
  const { config } = useWebAppConfig();
  const [revision, setRevision] = useState(0);
  const saveRequest = useRef<Promise<void> | undefined>(undefined);
  useRealtimeRefresh({
    enabled: Boolean(config?.currentUser),
    resources: [CLANKY_REALTIME_RESOURCES.theme],
    refresh: async (_event, signal) => {
      if (saveRequest.current) await Promise.allSettled([saveRequest.current]);
      if (!signal?.aborted) setRevision(current => current + 1);
    },
    deps: [config?.currentUser?.id],
  });
  // Replacing the adapter makes ThemeProvider reload without remounting the shell.
  return useMemo(() => config?.currentUser ? {
    async load() {
      const response = await appJson<{ theme: unknown }>("/api/preferences/theme");
      if (!isThemePreference(response.theme)) throw new Error("Theme preference response was invalid.");
      return response.theme;
    },
    save(preference: ThemePreference) {
      const request = appJson("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: preference }) }).then(() => undefined);
      // ThemeProvider awaits this same promise, committing before refresh resumes.
      saveRequest.current = request;
      return request;
    },
  } : undefined, [config?.currentUser?.id, revision]);
}

function ClankyApplicationContent({ children }: { children: ReactNode }) {
  const { config, external, loading, error, refresh } = useWebAppConfig();
  const theme = useAccountTheme();
  const logLevel = config?.logLevel.level ?? external?.logLevel;
  useEffect(() => {
    if (logLevel) setLogLevel(logLevel);
  }, [logLevel]);

  let boundary: ReactNode;
  if (error && !config) {
    boundary = <main className="wapp-auth-screen"><Panel title="Unable to load app" description={error.message} actions={<>
      {getClientSession().enabled ? <Button onClick={invalidateClientSession}>Change server</Button> : null}
      <Button onClick={() => void refresh()}>Retry</Button>
    </>} /></main>;
  } else if (loading && !config || !config && !external?.ready) {
    boundary = <main className="wapp-auth-screen"><p role="status">Loading...</p></main>;
  } else if (config) {
    const currentPage = pagePath(window.location.pathname);
    if (currentPage === pagePath(appPagePath("/setup"))) {
      boundary = <UserSetupScreen refresh={refresh} />;
    } else if (config.passkeyAuth.enabled && (config.passkeyAuth.bootstrapRequired
      || config.passkeyAuth.ownerPasskeySetupRequired
      || (!config.passkeyAuth.passkeyDisabled && config.passkeyAuth.passkeyRequired && !config.passkeyAuth.authenticated))) {
      boundary = <PasskeyAuthScreen status={config.passkeyAuth} apiKeysEnabled={config.apiKeys.enabled} refresh={refresh} />;
    } else if (config.deviceAuth.enabled && currentPage === pagePath(appPagePath("/device"))) {
      boundary = <DeviceVerificationScreen />;
    } else if (!getClientSession().enabled && currentPage === pagePath(appPagePath("/account"))) {
      boundary = <ServerAccountScreen config={config} refresh={refresh} />;
    } else if (!getClientSession().enabled && config.web?.mode === "auth") {
      boundary = <main className="wapp-auth-screen"><Panel title={config.appName} description="API-only server" /></main>;
    }
  }
  if (boundary !== undefined) {
    return <ThemeProvider adapter={theme}>{boundary}</ThemeProvider>;
  }
  const identity = config?.currentUser?.id ?? `${external?.scope ?? ""}:${external?.generation ?? 0}`;
  return <Fragment key={identity}>
    <AppearanceProvider accountBacked={Boolean(config?.currentUser)}>
      {children}
      {config?.currentUser ? <PerformanceStatsPanel version={config.version} /> : null}
    </AppearanceProvider>
  </Fragment>;
}

export function ClankyApplication({ children }: { children: ReactNode }) {
  return <WebAppConfigProvider><ClankyApplicationContent>{children}</ClankyApplicationContent></WebAppConfigProvider>;
}

export const ClankyRoot = forwardRef<WebAppRootController, WebAppRootProps>(function ClankyRoot(props, controllerRef) {
  const { config, external, refresh } = useWebAppConfig();
  const theme = useAccountTheme();
  const pins = useSidebarPinProvider();
  const version = getWebAppClientVersion() ?? props.version ?? config?.version ?? "";
  return <WebAppRoot
    {...props}
    ref={controllerRef}
    version={version}
    theme={theme}
    sidebar={{
      ...props.sidebar,
      pinning: props.sidebar.pinning === false ? false : {
        ...props.sidebar.pinning,
        ...(pins ? { provider: pins } : {}),
      },
    }}
    settings={undefined}
    routes={{
      ...props.routes,
      settings: (route) => <SettingsView
        config={config}
        external={external}
        appName={props.appName}
        version={version}
        refresh={refresh}
        customSections={props.settings?.sections ?? []}
        route={route}
        navigate={replaceWebAppRoute}
      />,
    }}
  />;
});
