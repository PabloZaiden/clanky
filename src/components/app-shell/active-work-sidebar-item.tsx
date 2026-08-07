import {
  Badge,
  formatStatusLabel,
  type SidebarItemRenderContext,
  type SidebarNode,
} from "@pablozaiden/webapp/web";

export type ActiveWorkSidebarItemType = "Task" | "Chat" | "SSH session";

export function ActiveWorkSidebarItem({
  node,
  itemType,
  itemProps,
}: {
  node: SidebarNode;
  itemType: ActiveWorkSidebarItemType;
  itemProps: SidebarItemRenderContext["itemProps"];
}) {
  const badgeLabel = node.badge ? formatStatusLabel(node.badge) : "";
  const isTextBadge = node.badgeAppearance === "text";

  return (
    <button {...itemProps}>
      <span>
        <strong>{node.title}</strong>
        {node.subtitle ? <small>{node.subtitle}</small> : null}
        <span className="clanky-active-work-sidebar-item-type">{itemType}</span>
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
    </button>
  );
}
