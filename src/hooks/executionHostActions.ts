import type {
  DevboxTemplateSummary,
  ExecutionHostRef,
  SshServerPrerequisiteReport,
  VncSession,
} from "@/shared";
import { getExecutionHostSourceId } from "@/shared";
import type {
  CheckSshServerPrerequisitesRequest,
  GetDevboxTemplatesRequest,
} from "@/contracts";
import { ApiError, isApiErrorCode } from "../lib/api-error";
import { apiRequest } from "../lib/api-client";
import {
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
  invalidateStoredSshCredentialToken,
  storeSshServerPassword,
} from "../lib/ssh-browser-credentials";

function executionHostApiPath(host: ExecutionHostRef): string {
  return `/api/execution-hosts/${host.kind}/${encodeURIComponent(getExecutionHostSourceId(host))}`;
}

async function resolveCredentialToken(serverId: string, password?: string): Promise<string> {
  const trimmedPassword = password?.trim();
  if (trimmedPassword) {
    await storeSshServerPassword(serverId, trimmedPassword);
  }

  const token = await getStoredSshCredentialToken(serverId);
  if (!token) {
    if (getStoredSshServerCredential(serverId)) {
      throw new ApiError("Stored SSH password is no longer valid. Enter the password again.", {
        code: "ssh_credential_invalid",
        status: 400,
      });
    }
    throw new ApiError("Enter the SSH password for this server.", {
      code: "ssh_credential_required",
      status: 400,
    });
  }
  return token;
}

async function resolveOptionalCredentialToken(
  serverId: string,
  password?: string,
): Promise<string | undefined> {
  const trimmedPassword = password?.trim();
  if (trimmedPassword) {
    await storeSshServerPassword(serverId, trimmedPassword);
  }
  return (await getStoredSshCredentialToken(serverId)) ?? undefined;
}

async function resolveExecutionHostCredentialToken(
  host: ExecutionHostRef,
  password?: string,
  required = false,
): Promise<string | undefined> {
  if (host.kind !== "ssh") {
    return undefined;
  }
  return required
    ? await resolveCredentialToken(host.serverId, password)
    : await resolveOptionalCredentialToken(host.serverId, password);
}

export async function checkExecutionHostPrerequisitesApi(options: {
  executionHost: ExecutionHostRef;
  password?: string;
}): Promise<SshServerPrerequisiteReport> {
  const credentialToken = await resolveExecutionHostCredentialToken(
    options.executionHost,
    options.password,
  );
  const request: CheckSshServerPrerequisitesRequest = {
    credentialToken: credentialToken ?? null,
  };
  return await apiRequest<SshServerPrerequisiteReport>(
    `${executionHostApiPath(options.executionHost)}/prerequisites`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Check execution host prerequisites",
      fallbackMessage: "Failed to check execution host prerequisites",
    },
  );
}

export async function listExecutionHostDevboxTemplatesApi(options: {
  executionHost: ExecutionHostRef;
  password?: string;
  signal?: AbortSignal;
}): Promise<DevboxTemplateSummary[]> {
  const credentialToken = await resolveExecutionHostCredentialToken(
    options.executionHost,
    options.password,
  );
  const request: GetDevboxTemplatesRequest = {
    credentialToken: credentialToken ?? null,
  };
  return await apiRequest<DevboxTemplateSummary[]>(
    `${executionHostApiPath(options.executionHost)}/devbox-templates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
      action: "List Devbox templates",
      fallbackMessage: "Failed to list Devbox templates",
    },
  );
}

export async function listExecutionHostVncSessionsApi(
  executionHost: ExecutionHostRef,
): Promise<VncSession[]> {
  return await apiRequest<VncSession[]>(
    `${executionHostApiPath(executionHost)}/vnc-sessions`,
    {
      method: "GET",
      action: "List VNC sessions",
      fallbackMessage: "Failed to list VNC sessions",
    },
  );
}

export async function createOrResumeExecutionHostVncSessionApi(options: {
  executionHost: ExecutionHostRef;
  remotePort: number;
  password?: string;
}): Promise<VncSession> {
  const credentialToken = await resolveExecutionHostCredentialToken(
    options.executionHost,
    options.password,
    options.executionHost.kind === "ssh",
  );
  const requestSession = async (token?: string) => await apiRequest<VncSession>(
    `${executionHostApiPath(options.executionHost)}/vnc-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        remotePort: options.remotePort,
        credentialToken: token || null,
      }),
      action: "Start VNC session",
      fallbackMessage: "Failed to start VNC session",
    },
  );

  try {
    return await requestSession(credentialToken);
  } catch (error) {
    if (!isApiErrorCode(error, "invalid_credential_token")) {
      throw error;
    }
    if (options.executionHost.kind !== "ssh") {
      throw error;
    }
    invalidateStoredSshCredentialToken(options.executionHost.serverId);
    return await requestSession(await resolveCredentialToken(options.executionHost.serverId));
  }
}

export async function closeExecutionHostVncSessionApi(sessionId: string): Promise<boolean> {
  await apiRequest(`/api/vnc-sessions/${sessionId}`, {
    method: "DELETE",
    action: "Close VNC session",
    fallbackMessage: "Failed to close VNC session",
  });
  return true;
}
