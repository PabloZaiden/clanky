import type { Workspace } from "@/shared/workspace";
import { ResourceImage } from "@pablozaiden/webapp/web";
import { FolderTreeIcon } from "./Icons";
import { ProviderIcon } from "./ProviderIcon";

export function WorkspaceIconMark({
  workspace,
  size = "h-4 w-4",
  className = "",
}: {
  workspace: Pick<Workspace, "id" | "workspaceIcon">;
  size?: string;
  className?: string;
}) {
  if (!workspace.workspaceIcon) {
    return <FolderTreeIcon size={size} className={`shrink-0 ${className}`.trim()} />;
  }

  const iconUrl =
    `/api/workspaces/${encodeURIComponent(workspace.id)}/icon?updatedAt=${
      encodeURIComponent(workspace.workspaceIcon.updatedAt)
    }`;
  return (
    <ResourceImage
      className={`${size} shrink-0 rounded-sm object-contain ${className}`.trim()}
      src={iconUrl}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}

export function WorkspaceIdentity({
  workspace,
  className = "",
  iconSize = "h-4 w-4",
  showProviderIcon = true,
}: {
  workspace: Workspace;
  className?: string;
  iconSize?: string;
  showProviderIcon?: boolean;
}) {
  return (
    <span
      className={`inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`.trim()}
      title={workspace.collaboration ? `${workspace.name} (${workspace.collaboration.controllerName})` : workspace.name}
    >
      <WorkspaceIconMark workspace={workspace} size={iconSize} />
      {showProviderIcon ? (
        <ProviderIcon
          provider={workspace.serverSettings.agent.provider}
          size="h-3 w-4"
          className="opacity-80"
        />
      ) : null}
      <span className="min-w-0 truncate font-medium">{workspace.name}</span>
      {workspace.collaboration ? <span className="truncate text-xs opacity-70">{workspace.collaboration.controllerName}</span> : null}
    </span>
  );
}
