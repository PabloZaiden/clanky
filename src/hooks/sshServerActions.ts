import type { DevboxTemplateSummary, SshServer, SshConnectionMode, SshServerPrerequisiteReport, SshServerSession, VncSession } from "@/shared";
import type { CheckSshServerPrerequisitesRequest, CreateSshServerRequest, GetDevboxTemplatesRequest, ListSshServersResponse, UpdateSshSessionRequest, UpdateSshServerRequest } from "@/contracts";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";
import {
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
  invalidateStoredSshCredentialToken,
  storeSshServerPassword,
} from "../lib/ssh-browser-credentials";

const log = createLogger("sshServerActions");

async function apiCall<T = unknown>(
  url: string,
  options: RequestInit,
  actionName: string,
): Promise<T> {
  let loggedFailure = false;

  try {
    const response = await appFetch(url, options);
    if (!response.ok) {
      const errorData = await response.json() as { message?: string };
      const message = errorData.message || `Failed to ${actionName.toLowerCase()}`;
      log.error("SSH server API request failed", { actionName, url, error: message });
      loggedFailure = true;
      throw new Error(message);
    }
    return await response.json() as T;
  } catch (error) {
    if (!loggedFailure) {
      log.error("SSH server API request failed", {
        actionName,
        url,
        error: String(error),
      });
    }
    throw error;
  }
}

async function resolveCredentialToken(serverId: string, password?: string): Promise<string> {
  const trimmedPassword = password?.trim();
  if (trimmedPassword) {
    await storeSshServerPassword(serverId, trimmedPassword);
  }

  const token = await getStoredSshCredentialToken(serverId);
  if (!token) {
    if (getStoredSshServerCredential(serverId)) {
      throw new Error("Stored SSH password is no longer valid. Enter the password again.");
    }
    throw new Error("Enter the SSH password for this server.");
  }
  return token;
}

async function resolveOptionalCredentialToken(serverId: string, password?: string): Promise<string | undefined> {
  const trimmedPassword = password?.trim();
  if (trimmedPassword) {
    await storeSshServerPassword(serverId, trimmedPassword);
  }
  return (await getStoredSshCredentialToken(serverId)) ?? undefined;
}

async function resolveBestEffortCredentialToken(serverId: string, password?: string): Promise<string | undefined> {
  try {
    return await resolveOptionalCredentialToken(serverId, password);
  } catch (error) {
    log.warn("Skipping optional SSH credential token lookup", {
      serverId,
      error: String(error),
    });
    return undefined;
  }
}

export async function listSshServersApi(): Promise<ListSshServersResponse> {
  return await apiCall<ListSshServersResponse>("/api/ssh-servers", { method: "GET" }, "List SSH servers");
}

export async function getSshServerApi(serverId: string): Promise<SshServer> {
  return await apiCall<SshServer>(`/api/ssh-servers/${serverId}`, { method: "GET" }, "Get SSH server");
}

export async function listSshServerSessionsApi(serverId: string): Promise<SshServerSession[]> {
  return await apiCall<SshServerSession[]>(
    `/api/ssh-servers/${serverId}/sessions`,
    { method: "GET" },
    "List SSH server sessions",
  );
}

export async function createSshServerApi(request: CreateSshServerRequest): Promise<SshServer> {
  return await apiCall<SshServer>(
    "/api/ssh-servers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Create SSH server",
  );
}

export async function updateSshServerApi(id: string, request: UpdateSshServerRequest): Promise<SshServer> {
  return await apiCall<SshServer>(
    `/api/ssh-servers/${id}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Update SSH server",
  );
}

export async function deleteSshServerApi(id: string): Promise<boolean> {
  await apiCall(`/api/ssh-servers/${id}`, { method: "DELETE" }, "Delete SSH server");
  return true;
}

export async function createStandaloneSshSessionApi(options: {
  serverId: string;
  name: string;
  connectionMode: SshConnectionMode;
  useTmux?: boolean;
}): Promise<SshServerSession> {
  return await apiCall<SshServerSession>(
    `/api/ssh-servers/${options.serverId}/sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: options.name.trim(),
        credentialToken: null,
        connectionMode: options.connectionMode,
        useTmux: options.useTmux,
      }),
    },
    "Create standalone SSH session",
  );
}

export async function updateStandaloneSshSessionApi(
  sessionId: string,
  request: UpdateSshSessionRequest,
): Promise<SshServerSession> {
  const body: UpdateSshSessionRequest = {};
  if (typeof request.name === "string") {
    body.name = request.name.trim();
  }
  if (typeof request.isPrivate === "boolean") {
    body.isPrivate = request.isPrivate;
  }

  return await apiCall<SshServerSession>(
    `/api/ssh-server-sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "Update standalone SSH session",
  );
}

export async function deleteStandaloneSshSessionApi(options: {
  sessionId: string;
  serverId: string;
  password?: string;
  requireCredential?: boolean;
}): Promise<boolean> {
  const credentialToken = options.requireCredential === false
    ? await resolveBestEffortCredentialToken(options.serverId, options.password) ?? null
    : await resolveCredentialToken(options.serverId, options.password);
  await apiCall(
    `/api/ssh-server-sessions/${options.sessionId}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken }),
    },
    "Delete standalone SSH session",
  );
  return true;
}

export async function saveStandaloneSshServerPassword(serverId: string, password: string): Promise<boolean> {
  await storeSshServerPassword(serverId, password.trim());
  log.debug("Saved encrypted standalone SSH password to browser storage", { serverId });
  return true;
}

export async function checkSshServerPrerequisitesApi(options: {
  serverId: string;
  password?: string;
}): Promise<SshServerPrerequisiteReport> {
  const credentialToken = await resolveOptionalCredentialToken(options.serverId, options.password);
  const request: CheckSshServerPrerequisitesRequest = {
    credentialToken: credentialToken ?? null,
  };
  return await apiCall<SshServerPrerequisiteReport>(
    `/api/ssh-servers/${options.serverId}/prerequisites/check`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    },
    "Check SSH server prerequisites",
  );
}

export async function listDevboxTemplatesApi(options: {
  serverId: string;
  password?: string;
  signal?: AbortSignal;
}): Promise<DevboxTemplateSummary[]> {
  const credentialToken = await resolveOptionalCredentialToken(options.serverId, options.password);
  const request: GetDevboxTemplatesRequest = {
    credentialToken: credentialToken ?? null,
  };
  return await apiCall<DevboxTemplateSummary[]>(
    `/api/ssh-servers/${options.serverId}/devbox/templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    },
    "List devbox templates",
  );
}

export async function listVncSessionsApi(serverId: string): Promise<VncSession[]> {
  return await apiCall<VncSession[]>(
    `/api/ssh-servers/${serverId}/vnc-sessions`,
    { method: "GET" },
    "List VNC sessions",
  );
}

export async function createOrResumeVncSessionApi(options: {
  serverId: string;
  remotePort: number;
  password?: string;
}): Promise<VncSession> {
  const credentialToken = await resolveCredentialToken(options.serverId, options.password);
  const requestSession = async (token: string) => await apiCall<VncSession>(
      `/api/ssh-servers/${options.serverId}/vnc-sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: options.remotePort,
          credentialToken: token,
        }),
      },
      "Start VNC session",
    );

  try {
    return await requestSession(credentialToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("credential token")) {
      throw error;
    }
    invalidateStoredSshCredentialToken(options.serverId);
    return await requestSession(await resolveCredentialToken(options.serverId));
  }
}

export async function closeVncSessionApi(sessionId: string): Promise<boolean> {
  await apiCall(`/api/vnc-sessions/${sessionId}`, { method: "DELETE" }, "Close VNC session");
  return true;
}
