import {
  Badge,
  formatStatusLabel,
  type SidebarNode,
} from "@pablozaiden/webapp/web";

export type ActiveWorkSidebarItemType = "Task" | "Chat" | "SSH session";

export function ActiveWorkSidebarItem({
  node,
  itemType,
}: {
  node: SidebarNode;
  itemType: ActiveWorkSidebarItemType;
}) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const isTextBadge = node.badgeAppearance === "text";

  return (
    <>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
        <small className="clanky-active-work-sidebar-item-type">{itemType}</small>
      </span>
      {node.badge ? (
        <Badge
          variant={node.badgeVariant}
          appearance={isTextBadge ? "text" : "pill"}
          className={[
            "wapp-sidebar-badge",
            isTextBadge ? "wapp-sidebar-badge-text" : "",
          ].filter(Boolean).join(" ")}
          title={badgeLabel}
          aria-label={badgeLabel}
        >
          {isTextBadge ? badgeLabel : " "}
        </Badge>
      ) : null}
    </>
  );
}
