import { isQuestionOpen } from "@/shared/harness-questions";
import { getRecentActivityTimestamp, isTaskPlanReady } from "../../utils";
import type { BadgeVariant } from "../common";
import type { SidebarActiveWorkItem } from "./shell-types";

export interface OverviewAttention {
  label: string;
  variant: BadgeVariant;
}

const ATTENTION = {
  plan: { label: "Plan ready", variant: "plan_ready" },
  question: { label: "Question", variant: "warning" },
  permission: { label: "Permission", variant: "warning" },
  error: { label: "Error", variant: "error" },
} satisfies Record<string, OverviewAttention>;

export function getOverviewAttention(item: SidebarActiveWorkItem): OverviewAttention | null {
  if (item.kind === "terminal-session" || item.kind === "execution-host-terminal") {
    return item.sessionNode.session.state.status === "failed" ? ATTENTION.error : null;
  }
  const state = item.kind === "task" ? item.taskNode.task.state : item.chatNode.chat.state;
  const hasQuestion = state.harness?.questions?.some((question) => (
    isQuestionOpen(question) && question.status !== "queued" && question.status !== "submitting"
  ));
  if (hasQuestion) return ATTENTION.question;
  if (item.kind !== "task" && item.chatNode.chat.state.pendingPermissionRequests?.some((request) => request.status === "pending")) {
    return ATTENTION.permission;
  }
  if (state.status === "failed" || state.error) return ATTENTION.error;
  if (item.kind === "task" && isTaskPlanReady(item.taskNode.task)) return ATTENTION.plan;
  return null;
}

export function getOverviewActivityTimestamp(item: SidebarActiveWorkItem): string {
  if (item.kind === "task") return getRecentActivityTimestamp(item.taskNode.task);
  if (item.kind === "chat" || item.kind === "execution-host-chat") {
    const { config, state } = item.chatNode.chat;
    return state.lastActivityAt ?? state.completedAt ?? config.updatedAt ?? config.createdAt;
  }
  return item.sessionNode.session.state.lastConnectedAt ?? item.sessionNode.session.config.createdAt;
}
