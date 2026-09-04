import {
  Badge,
  formatStatusLabel,
  type SidebarNode,
} from "@pablozaiden/webapp/web";
import { CloudIcon, MeshIcon, ServerIcon } from "../common";

export type ServerTransportKind = "local" | "mesh" | "ssh";

function getTransportLabel(transport: ServerTransportKind): string {
  switch (transport) {
    case "local":
      return "Local transport";
    case "mesh":
      return "Mesh transport";
    case "ssh":
      return "SSH transport";
  }
}

export function ServerTransportIcon({
  transport,
  size = "h-4 w-4",
}: {
  transport: ServerTransportKind;
  size?: string;
}) {
  const label = getTransportLabel(transport);
  const icon = transport === "local"
    ? <ServerIcon size={size} />
    : transport === "mesh"
      ? <MeshIcon size={size} />
      : <CloudIcon size={size} />;

  return (
    <span
      className="inline-flex text-gray-500 dark:text-gray-400"
      title={label}
      aria-label={label}
    >
      {icon}
    </span>
  );
}

export function ServerSidebarItem({
  node,
  transport,
}: {
  node: SidebarNode;
  transport: ServerTransportKind;
}) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <ServerTransportIcon transport={transport} />
        {node.badge ? (
          <Badge
            variant={node.badgeVariant}
            appearance="pill"
            className="wapp-sidebar-badge"
            title={badgeLabel}
            aria-label={badgeLabel}
          >
            {" "}
          </Badge>
        ) : null}
      </span>
    </>
  );
}
