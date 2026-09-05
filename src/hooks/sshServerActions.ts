import type { SshServer } from "@/shared";
import type {
  CreateSshServerRequest,
  ListSshServersResponse,
  UpdateSshServerRequest,
} from "@/contracts";
import { createLogger } from "@pablozaiden/webapp/web";
import { apiRequest } from "../lib/api-client";
import { storeSshServerPassword } from "../lib/ssh-browser-credentials";

const log = createLogger("sshServerActions");

async function apiCall<T = unknown>(
  url: string,
  options: RequestInit,
  actionName: string,
): Promise<T> {
  return await apiRequest<T>(url, {
    ...options,
    action: actionName,
    fallbackMessage: `Failed to ${actionName.toLowerCase()}`,
  });
}

export async function listSshServersApi(): Promise<ListSshServersResponse> {
  return await apiCall<ListSshServersResponse>("/api/ssh-servers", { method: "GET" }, "List SSH servers");
}

export async function getSshServerApi(serverId: string): Promise<SshServer> {
  return await apiCall<SshServer>(`/api/ssh-servers/${serverId}`, { method: "GET" }, "Get SSH server");
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

export async function saveStandaloneSshServerPassword(serverId: string, password: string): Promise<boolean> {
  await storeSshServerPassword(serverId, password.trim());
  log.debug("Saved encrypted standalone SSH password to browser storage", { serverId });
  return true;
}
