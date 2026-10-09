/**
 * Prompt provenance and transient UI commands for Clanky control chats.
 */

import { z } from "zod";
import type { Chat } from "./chat";

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

export function isClankyControlChat(chat: Pick<Chat, "config">, workspaceId: string | undefined): boolean {
  const provider = chat.config.model.providerID;
  return Boolean(workspaceId)
    && chat.config.scope === "workspace"
    && chat.config.source?.kind !== "execution_host"
    && (chat.config.source?.workspaceId ?? chat.config.workspaceId) === workspaceId
    && (provider === "codex" || provider === "copilot");
}

export const ControlUiActionSchema = z.discriminatedUnion("type", [
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
]);

export type ControlUiAction = z.infer<typeof ControlUiActionSchema>;

export const ControlUiActionOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("opened"),
    action: ControlUiActionSchema,
  }).strict(),
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
  chatId: z.string().min(1).max(500),
  workspaceId: z.string().min(1).max(500),
  clientId: z.string().uuid(),
  turnId: z.string().uuid(),
  expiresAt: z.number().int().positive(),
  action: ControlUiActionSchema,
}).strict();

export type ControlUiActionEvent = z.infer<typeof ControlUiActionEventSchema>;
