/**
 * Badge component for displaying status or labels.
 */

import type { HTMLAttributes } from "react";
import { Badge as FrameworkBadge } from "@pablozaiden/webapp/web";
import type { ChatStatus, ProvisioningJobStatus, SshSessionStatus } from "@/shared";

export type BadgeVariant = import("@pablozaiden/webapp/web").BadgeVariant;

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** Visual variant */
  variant?: BadgeVariant;
  /** Size */
  size?: "sm" | "md";
  /** Badge text */
  children: React.ReactNode;
}

export function Badge({
  variant = "default",
  size = "sm",
  children,
  className = "",
  ...props
}: BadgeProps) {
  return (
    <FrameworkBadge
      data-badge-variant={variant}
      variant={variant}
      className={size === "md" ? `clanky-badge-md ${className}`.trim() : className}
      {...props}
    >
      {children}
    </FrameworkBadge>
  );
}

/**
 * Get the badge variant for a task status.
 */
export function getStatusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case "idle":
      return "idle";
    case "planning":
      return "planning";
    case "starting":
    case "running":
    case "waiting":
    case "resolving_conflicts":
      return "running";
    case "completed":
      return "completed";
    case "stopped":
    case "max_iterations":
      return "stopped";
    case "failed":
      return "failed";
    case "merged":
      return "merged";
    case "pushed":
      return "pushed";
    case "deleted":
      return "deleted";
    default:
      return "default";
  }
}

export function getChatStatusBadgeVariant(status: ChatStatus): BadgeVariant {
  switch (status) {
    case "starting":
    case "streaming":
    case "reconnecting":
      return "info";
    case "interrupting":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
      return "stopped";
    case "idle":
    default:
      return "success";
  }
}

export function getSshSessionStatusBadgeVariant(status: SshSessionStatus): BadgeVariant {
  switch (status) {
    case "connected":
      return "success";
    case "connecting":
      return "info";
    case "failed":
      return "error";
    case "disconnected":
      return "warning";
    case "ready":
    default:
      return "default";
  }
}

export function getSshSessionStatusLabel(status: SshSessionStatus): string {
  switch (status) {
    case "connected": return "Connected";
    case "connecting": return "Connecting";
    case "disconnected": return "Disconnected";
    case "failed": return "Failed";
    case "ready": return "Ready";
  }
}

export function getProvisioningStatusBadgeVariant(status: ProvisioningJobStatus): BadgeVariant {
  switch (status) {
    case "running":
    case "pending": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "warning";
  }
}

export function getProvisioningStatusLabel(status: ProvisioningJobStatus): string {
  switch (status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

export default Badge;
