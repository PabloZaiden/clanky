import type {
  RestartAutomaticWorkspacesRequest,
  RestartAutomaticWorkspacesResponse,
} from "@/contracts";
import { apiRequest } from "../lib/api-client";

export async function restartAutomaticWorkspacesApi(
  request: RestartAutomaticWorkspacesRequest,
): Promise<RestartAutomaticWorkspacesResponse> {
  return await apiRequest<RestartAutomaticWorkspacesResponse>(
    "/api/settings/restart-automatic-workspaces",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      action: "Restart automatic workspaces",
      fallbackMessage: "Failed to start automatic workspace restart jobs",
    },
  );
}
