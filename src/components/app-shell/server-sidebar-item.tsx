import {
  Badge,
  formatStatusLabel,
  type SidebarNode,
} from "@pablozaiden/webapp/web";
import { CloudIcon, MeshIcon, ServerIcon } from "../common";

export type ServerTransportKind = "local" | "mesh" | "ssh";

function transportPresentation(transport: ServerTransportKind) {
  switch (transport) {
    case "local":
      return {
        label: "Local transport",
        icon: <ServerIcon size="h-4 w-4" />,
      };
    case "mesh":
      return {
        label: "Mesh transport",
        icon: <MeshIcon size="h-4 w-4" />,
      };
    case "ssh":
      return {
        label: "SSH transport",
        icon: <CloudIcon size="h-4 w-4" />,
      };
  }
}

export function ServerSidebarItem({
  node,
  transport,
}: {
  node: SidebarNode;
  transport: ServerTransportKind;
}) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const presentation = transportPresentation(transport);

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span
          className="inline-flex text-gray-500 dark:text-gray-400"
          title={presentation.label}
          aria-label={presentation.label}
        >
          {presentation.icon}
        </span>
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
