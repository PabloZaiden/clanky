import type { Workspace } from "../types";

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function getPreviewWorkspaceReference(workspace: Workspace, workspaces: Workspace[]): string {
  const sameNameCount = workspaces.filter((candidate) => candidate.name === workspace.name).length;
  return sameNameCount === 1 ? workspace.name : workspace.id;
}

export function buildPreviewCliCommand(options: {
  workspace: Workspace;
  workspaces: Workspace[];
  port: string;
}): string {
  const workspaceReference = getPreviewWorkspaceReference(options.workspace, options.workspaces);
  const port = options.port.trim() || "3000";
  return `clanky preview --workspace ${shellArg(workspaceReference)} --port ${port}`;
}
