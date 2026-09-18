import {
  usePreviewSessions,
  type PreviewSessionScope,
  type UsePreviewSessionsResult,
} from "./usePreviewSessions";

export type UseWorkspacePreviewsResult = UsePreviewSessionsResult;

export function useWorkspacePreviews(workspaceId: string): UseWorkspacePreviewsResult {
  const scope: PreviewSessionScope = { kind: "workspace", workspaceId };
  return usePreviewSessions(scope);
}
