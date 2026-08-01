import {
  StatusBadge as WebAppStatusBadge,
  type BadgeProps,
} from "@pablozaiden/webapp/web";
import { formatStatusLabel } from "./status-variants";

export function StatusBadge({
  children,
  className = "",
  ...props
}: BadgeProps) {
  const label = typeof children === "string" ? formatStatusLabel(children) : children;
  return (
    <WebAppStatusBadge
      {...props}
      className={["clanky-status-badge", className].filter(Boolean).join(" ")}
    >
      {label}
    </WebAppStatusBadge>
  );
}
