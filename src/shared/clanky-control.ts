/**
 * Prompt provenance and transient UI commands for Clanky control chats.
 */

import { z } from "zod";
import type { Chat } from "./chat";
import type { HarnessCapabilities } from "./harness-control";
import { ControlClientContextSchema, ControlClientActionSchema } from "./control-interactions";

export const ClankyControlContextSchema = z.object({
  chatId: z.string().min(1).max(500),
  clientId: z.string().uuid().optional(),
  turnId: z.string().uuid(),
  workspaceId: z.string().min(1).max(500),
  defaultModel: z.object({
    providerID: z.string().min(1).max(500),
    modelID: z.string().min(1).max(500),
    variant: z.string().max(1000).optional(),
  }).strict(),
}).strict();

export type ClankyControlContext = z.infer<typeof ClankyControlContextSchema>;

export function isClankyControlChat(
  chat: Pick<Chat, "config">,
  adapter: HarnessCapabilities["adapter"] | undefined,
): boolean {
  return chat.config.source?.kind !== "execution_host"
    && Boolean(chat.config.source?.workspaceId ?? chat.config.workspaceId)
    && (adapter === "codex" || adapter === "copilot" || adapter === "opencode2");
}

export const ControlNavigationActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("open_workspace"),
    workspaceId: z.string().min(1).max(500),
  }).strict(),
  z.object({
    type: z.literal("open_workspace_file"),
    workspaceId: z.string().min(1).max(500),
    filePath: z.string().min(1).max(16_384),
  }).strict(),
  z.object({
    type: z.literal("open_chat"),
    chatId: z.string().min(1).max(500),
  }).strict(),
  z.object({ type: z.literal("open_task"), taskId: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("open_agent"), agentId: z.string().min(1).max(500) }).strict(),
  z.object({ type: z.literal("open_terminal"), terminalSessionId: z.string().min(1).max(500) }).strict(),
  z.object({
    type: z.literal("open_execution_host"),
    kind: z.enum(["local", "mesh"]),
    id: z.string().min(1).max(500),
  }).strict(),
  z.object({ type: z.literal("open_home") }).strict(),
  z.object({ type: z.literal("open_settings") }).strict(),
  z.object({
    type: z.literal("sidebar"),
    command: z.enum(["open", "search", "select_tab"]),
    tabId: z.string().min(1).max(100).nullable(),
  }).strict(),
]);

export const ControlUiActionSchema = z.union([ControlNavigationActionSchema, ControlClientActionSchema]);
export type ControlUiAction = z.infer<typeof ControlUiActionSchema>;

export const ControlUiSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat_turn"),
    chatId: z.string().min(1).max(500),
    workspaceId: z.string().min(1).max(500),
    turnId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("live_voice"),
    callId: z.string().uuid(),
    requestId: z.string().min(1).max(500),
  }).strict(),
]);
export type ControlUiSource = z.infer<typeof ControlUiSourceSchema>;

export const ControlUiActionOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("opened"),
    action: ControlUiActionSchema,
  }).strict(),
  z.object({ status: z.literal("presented") }).strict(),
  z.object({ status: z.literal("context"), context: ControlClientContextSchema }).strict(),
  z.object({
    status: z.literal("failed"),
    code: z.enum([
      "workspace_unavailable",
      "editor_dirty",
      "file_open_failed",
      "file_not_loaded",
      "navigation_failed",
      "control_action_timeout",
      "control_action_busy",
    ]),
    message: z.string().trim().min(1).max(1000),
  }).strict(),
]);

export type ControlUiActionOutcome = z.infer<typeof ControlUiActionOutcomeSchema>;

export const ControlUiActionEventSchema = z.object({
  type: z.literal("control.ui_action"),
  actionId: z.string().uuid(),
  source: ControlUiSourceSchema,
  clientId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  action: ControlUiActionSchema,
}).strict();

export type ControlUiActionEvent = z.infer<typeof ControlUiActionEventSchema>;
