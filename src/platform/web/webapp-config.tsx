import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { VALID_LOG_LEVELS, type WebAppConfigResponse } from "@/platform/contracts";
import { appJson, getWebAppExternalClient, isWebAppPublicBasePath, onAuthRequired, setWebAppPublicBasePath } from "./api-client";
import { getClientSession } from "./client-session";
import { configureWebAppClient, validateExternalSession, type WebAppExternalClient, type WebAppExternalSession } from "@pablozaiden/webapp/web";
import { setClankyClientIdentity } from "./runtime";

export interface WebAppConfigState {
  config?: WebAppConfigResponse;
  external?: WebAppExternalSession;
  loading: boolean;
  error?: Error;
  refresh: () => Promise<void>;
}

const WebAppConfigContext = createContext<WebAppConfigState | null>(null);


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLogLevelName(value: unknown): boolean {
  return typeof value === "string" && VALID_LOG_LEVELS.includes(value as WebAppConfigResponse["logLevel"]["level"]);
}

function isCurrentUser(value: unknown): boolean {
  return isRecord(value)
    && typeof value["id"] === "string"
    && typeof value["username"] === "string"
    && (value["role"] === "owner" || value["role"] === "admin" || value["role"] === "user")
    && typeof value["isOwner"] === "boolean"
    && typeof value["isAdmin"] === "boolean";
}

function hasBooleanFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => typeof value[field] === "boolean");
}

function isWebAppConfigResponse(value: unknown): value is WebAppConfigResponse {
  return isRecord(value)
    && typeof value["appName"] === "string"
    && typeof value["version"] === "string"
    && isWebAppPublicBasePath(value["publicBasePath"])
    && isRecord(value["realtime"])
    && isWebAppPublicBasePath(value["realtime"]["path"])
    && (value["currentUser"] === undefined || isCurrentUser(value["currentUser"]))
    && hasBooleanFields(value["passkeyAuth"], [
      "enabled",
      "passkeyConfigured",
      "passkeyDisabled",
      "passkeyRequired",
      "authenticated",
      "bootstrapRequired",
      "ownerPasskeySetupRequired",
      "passkeyAvailable",
      "passwordEnabled",
    ])
    && hasBooleanFields(value["userManagement"], ["enabled", "canManageUsers"])
    && isRecord(value["logLevel"])
    && isLogLevelName(value["logLevel"]["level"])
    && typeof value["logLevel"]["fromEnv"] === "boolean"
    && hasBooleanFields(value["inMemoryLogs"], ["enabled"])
    && hasBooleanFields(value["deviceAuth"], ["enabled"])
    && hasBooleanFields(value["apiKeys"], ["enabled"]);
}

export function parseWebAppConfigResponse(value: unknown): WebAppConfigResponse {
  if (!isWebAppConfigResponse(value)) {
    throw new Error("Web app configuration response was invalid.");
  }
  return value;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function useWebAppConfig(consumer = "useWebAppConfig"): WebAppConfigState {
  const context = useContext(WebAppConfigContext);
  if (!context) {
    throw new Error(`${consumer} must be used within ClankyRoot.`);
  }
  return context;
}

export function useCurrentUser(): WebAppConfigResponse["currentUser"] {
  return useWebAppConfig("useCurrentUser").config?.currentUser;
}

function ServerWebAppConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<WebAppConfigResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error>();
  const requestIdRef = useRef(0);
  const requestRef = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError(undefined);

    try {
      const response = parseWebAppConfigResponse(await appJson<unknown>("/api/config", { signal: request.signal }));
      if (requestId !== requestIdRef.current) {
        return;
      }
      if (!getClientSession().enabled) setWebAppPublicBasePath(response.publicBasePath);
      configureWebAppClient({ realtimePath: response.realtime.path });
      setClankyClientIdentity(response.currentUser?.id, response.logLevel.level);
      setConfig(response);
    } catch (value) {
      if (requestId === requestIdRef.current) {
        setError(toError(value));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        requestRef.current = undefined;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthRequired(() => {
      setConfig(undefined);
      void refresh();
    });
    void refresh();
    return () => {
      unsubscribe();
      requestIdRef.current++;
      requestRef.current?.abort();
      requestRef.current = undefined;
      setClankyClientIdentity(undefined);
    };
  }, [refresh]);

  const state = useMemo<WebAppConfigState>(() => ({
    config,
    loading,
    error,
    refresh,
  }), [config, error, loading, refresh]);

  return <WebAppConfigContext.Provider value={state}>{children}</WebAppConfigContext.Provider>;
}

function useExternalSessionSnapshot(client: WebAppExternalClient): WebAppExternalSession;
function useExternalSessionSnapshot(client?: WebAppExternalClient): WebAppExternalSession | undefined;
function useExternalSessionSnapshot(client?: WebAppExternalClient): WebAppExternalSession | undefined {
  const subscribe = useCallback((listener: () => void) => client?.session.subscribe(listener) ?? (() => {}), [client]);
  const snapshot = useCallback(() => client ? validateExternalSession(client.session.getSnapshot()) : undefined, [client]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function ExternalWebAppConfigProvider({ client, children }: { client: WebAppExternalClient; children: ReactNode }) {
  const external = useExternalSessionSnapshot(client);
  const refresh = useCallback(async () => { await client.session.refresh(); }, [client]);
  const state = useMemo<WebAppConfigState>(() => ({
    external,
    loading: !external.ready,
    error: external.error,
    refresh,
  }), [external, refresh]);
  return <WebAppConfigContext.Provider value={state}>{children}</WebAppConfigContext.Provider>;
}

export function WebAppConfigProvider({ children }: { children: ReactNode }) {
  const client = getWebAppExternalClient();
  return client
    ? <ExternalWebAppConfigProvider client={client}>{children}</ExternalWebAppConfigProvider>
    : <ServerWebAppConfigProvider>{children}</ServerWebAppConfigProvider>;
}

/** External state is local presentation state and does not imply a server role. */
export function useExternalClientSession(): WebAppExternalSession | undefined {
  return useExternalSessionSnapshot(getWebAppExternalClient());
}
