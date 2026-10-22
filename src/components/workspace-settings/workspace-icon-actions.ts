import type { WorkspaceIconResponse } from "@/contracts/schemas";
import { apiRequest } from "../../lib/api-client";

export type WorkspaceIconChange =
  | { kind: "upload"; file: File }
  | { kind: "repository"; path: string }
  | { kind: "remove" };

export async function saveWorkspaceIcon(workspaceId: string, change: WorkspaceIconChange) {
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}/icon`;
  if (change.kind === "remove") {
    await apiRequest(path, {
      method: "DELETE",
      action: "Remove workspace icon",
      fallbackMessage: "Unable to remove workspace icon.",
    });
    return undefined;
  }

  let result: WorkspaceIconResponse;
  if (change.kind === "upload") {
    const body = new FormData();
    body.append("icon", change.file);
    result = await apiRequest<WorkspaceIconResponse>(`${path}-upload`, {
      method: "POST",
      body,
      action: "Upload workspace icon",
      fallbackMessage: "Unable to upload workspace icon.",
    });
  } else {
    result = await apiRequest<WorkspaceIconResponse>(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: change.path }),
      action: "Select workspace icon",
      fallbackMessage: "Unable to select workspace icon.",
    });
  }
  return result.workspaceIcon;
}
