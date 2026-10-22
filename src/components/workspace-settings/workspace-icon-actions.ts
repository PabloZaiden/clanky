import type { WorkspaceIconCandidate, WorkspaceIconResponse } from "@/contracts/schemas";
import { apiRequest } from "../../lib/api-client";

export type WorkspaceIconChange =
  | { kind: "upload"; file: File }
  | { kind: "repository"; path: string; file: File }
  | { kind: "remove" };

export function workspaceIconCandidatePath(workspaceId: string, path: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/icon-candidate-preview?path=${encodeURIComponent(path)}`;
}

export async function loadWorkspaceIconCandidate(
  workspaceId: string,
  candidate: WorkspaceIconCandidate,
  signal: AbortSignal,
): Promise<WorkspaceIconChange> {
  const content = await apiRequest(workspaceIconCandidatePath(workspaceId, candidate.path), {
    responseType: "blob",
    signal,
    action: "Select workspace icon",
    fallbackMessage: "Unable to load the selected workspace icon.",
  });
  return {
    kind: "repository",
    path: candidate.path,
    file: new File([content], candidate.name, { type: content.type }),
  };
}

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

  const body = new FormData();
  body.append("icon", change.file);
  const result = await apiRequest<WorkspaceIconResponse>(`${path}-upload`, {
    method: "POST",
    body,
    action: "Upload workspace icon",
    fallbackMessage: "Unable to upload workspace icon.",
  });
  return result.workspaceIcon;
}
