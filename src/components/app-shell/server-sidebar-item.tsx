import type { SidebarNode } from "@pablozaiden/webapp/web";
import { CloudIcon, MeshIcon, ServerIcon } from "../common";

export type ServerTransportKind = "local" | "mesh" | "ssh";

export function getServerTransportLabel(transport: ServerTransportKind): string {
  switch (transport) {
    case "local":
      return "Local";
    case "mesh":
      return "Mesh";
    case "ssh":
      return "SSH";
  }
}

export function ServerTransportIcon({
  transport,
  size = "h-4 w-4",
}: {
  transport: ServerTransportKind;
  size?: string;
}) {
  const label = `${getServerTransportLabel(transport)} transport`;
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
  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
      </span>
      <ServerTransportIcon transport={transport} />
    </>
  );
}
