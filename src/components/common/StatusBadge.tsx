/**
 * StatusBadge component for displaying status labels with consistent styling.
 * Always renders uppercase with letter-spacing, matching the sidebar style.
 * Use this for all loop, chat, SSH, port forward, and provisioning status labels.
 * Use the plain Badge component for non-status informational labels (e.g. "Chat", "Addressable").
 */

import { Badge, type BadgeProps } from "./Badge";

export function StatusBadge({ className = "", ...props }: BadgeProps) {
  return (
    <Badge
      className={`uppercase tracking-wide ${className}`}
      {...props}
    />
  );
}

export default StatusBadge;
