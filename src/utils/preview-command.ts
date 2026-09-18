import {
  getExecutionHostSourceId,
  type ExecutionHostDescriptor,
  type Workspace,
} from "@/shared";

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function getPreviewWorkspaceReference(workspace: Workspace, workspaces: Workspace[]): string {
  const workspaceName = workspace.name.trim();
  if (!workspaceName) {
    return workspace.id;
  }
  const sameNameCount = workspaces.filter((candidate) => candidate.name.trim() === workspaceName).length;
  return sameNameCount === 1 ? workspaceName : workspace.id;
}

export function getPreviewServerReference(
  server: ExecutionHostDescriptor,
  servers: ExecutionHostDescriptor[],
): string {
  const serverName = server.name.trim();
  if (!serverName) {
    return getExecutionHostSourceId(server.ref);
  }
  const sameNameCount = servers.filter((candidate) => candidate.name.trim() === serverName).length;
  return sameNameCount === 1
    ? serverName
    : getExecutionHostSourceId(server.ref);
}

function sanitizePreviewPort(port: string): string {
  const trimmedPort = port.trim();
  if (!/^\d+$/.test(trimmedPort)) {
    return "3000";
  }
  const parsedPort = Number(trimmedPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return "3000";
  }
  return String(parsedPort);
}

export function buildPreviewCliCommand(options: {
  workspace: Workspace;
  workspaces: Workspace[];
  port: string;
} | {
  server: ExecutionHostDescriptor;
  servers: ExecutionHostDescriptor[];
  port: string;
}): string {
  const port = sanitizePreviewPort(options.port);
  if ("workspace" in options) {
    const workspaceReference = getPreviewWorkspaceReference(options.workspace, options.workspaces);
    return `clanky preview --workspace ${shellArg(workspaceReference)} --port ${port}`;
  }
  const serverReference = getPreviewServerReference(options.server, options.servers);
  return `clanky preview --server ${shellArg(serverReference)} --port ${port}`;
}
