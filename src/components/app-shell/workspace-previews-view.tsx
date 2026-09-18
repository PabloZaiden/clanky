import type { Workspace } from "@/shared";
import { PreviewSessionsView } from "./preview-sessions-view";
import { buildPreviewCliCommand } from "../../utils";

export function WorkspacePreviewsView({
  workspace,
  workspaces,
}: {
  workspace: Workspace;
  workspaces: Workspace[];
}) {
  return (
    <PreviewSessionsView
      scope={{ kind: "workspace", workspaceId: workspace.id }}
      buildCommand={(port) => buildPreviewCliCommand({ workspace, workspaces, port })}
    />
  );
}
