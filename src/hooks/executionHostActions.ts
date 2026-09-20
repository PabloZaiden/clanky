import type {
  DevboxTemplateSummary,
  ExecutionHostRef,
  SshServerPrerequisiteReport,
} from "@/shared";
import { getExecutionHostSourceId, getRegisteredSshServerId } from "@/shared";
import type {
  CheckSshServerPrerequisitesRequest,
  GetDevboxTemplatesRequest,
} from "@/contracts";
import { apiRequest } from "../lib/api-client";
import {
  getStoredSshCredentialToken,
  storeSshServerPassword,
} from "../lib/ssh-browser-credentials";

function executionHostApiPath(host: ExecutionHostRef): string {
  return `/api/execution-hosts/${host.kind}/${encodeURIComponent(getExecutionHostSourceId(host))}`;
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
): Promise<string | undefined> {
  if (host.kind !== "ssh") {
    return undefined;
  }
  const serverId = getRegisteredSshServerId(host);
  if (!serverId) {
    return undefined;
  }
  return await resolveOptionalCredentialToken(serverId, password);
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
