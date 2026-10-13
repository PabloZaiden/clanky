/**
 * Small model-facing tools for the user's global Clanky assistant.
 */

import { z } from "zod";
import { ControlNavigationActionSchema } from "@/shared/clanky-control";
import { ExecuteOperationSchema, type ClankyOperationService } from "./clanky-operation-service";
import { VoiceConfirmationDescriptionSchema } from "@/shared/live-voice";
import type { LiveVoiceActions } from "./live-voice-actions";
import type { LiveVoiceObserver } from "./live-voice-observer";
import { isDomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("core:voice-tools");
const schemas = {
  clanky_find_operations: z.object({
    text: z.string().max(500),
    domain: z.string().max(100).nullable(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).nullable(),
    cursor: z.number().int().nonnegative().max(10_000).nullable(),
  }).strict(),
  clanky_describe_operation: z.object({ operationId: z.string().min(1).max(500) }).strict(),
  clanky_execute_operation: ExecuteOperationSchema.extend({
    confirmationDescription: VoiceConfirmationDescriptionSchema.nullable(),
  }),
  clanky_get_ui_state: z.object({}).strict(),
  clanky_ui_action: z.object({ action: ControlNavigationActionSchema }).strict(),
  clanky_watch_work: z.object({
    command: z.enum(["add", "remove", "list"]),
    targets: z.array(z.object({
      kind: z.enum(["chat", "task", "provisioning"]),
      id: z.string().min(1).max(500),
    }).strict()).max(16),
  }).strict(),
};

const descriptions: Record<keyof typeof schemas, string> = {
  clanky_find_operations: "Find authorized Clanky operations by words/domain/method. Empty text lists a page. Discover before acting.",
  clanky_describe_operation: "Read the exact path/query/body contract and risk/completion policy for an operation.",
  clanky_execute_operation: "Execute a described API operation with exact parameters/query and bodyJson (null without a body). For policy confirm, supply confirmationDescription: one or two short plain-text sentences in the user's language describing the exact action, named target and material consequences. No API paths, technical identifiers, JSON or credentials. Use null for other policies. Mutations are never retried automatically. High-risk actions prepare a visual confirmation, not execution.",
  clanky_get_ui_state: "Read a fresh acknowledged snapshot of the originating client's route and saved task planning preferences. UI context is not authoritative entity state.",
  clanky_ui_action: "Navigate the originating client or control its sidebar. Returns success only after that tab acknowledges the effect. Never supplies confirmation approval.",
  clanky_watch_work: "Watch selected owned chats/tasks/provisioning jobs for meaningful state changes. Ending voice stops watching, not the work.",
};

export const liveVoiceToolDefinitions = Object.entries(schemas).map(([name, schema]) => {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === ControlNavigationActionSchema && jsonSchema.oneOf) {
        // Distinct type literals make anyOf equivalent; strict Responses tools do not support oneOf.
        jsonSchema.anyOf = jsonSchema.oneOf;
        delete jsonSchema.oneOf;
      }
    },
  });
  return { type: "function", name, description: descriptions[name as keyof typeof schemas], parameters, strict: true };
});

export async function executeLiveVoiceTool(options: {
  service: ClankyOperationService;
  actions: LiveVoiceActions;
  observer: LiveVoiceObserver;
  requestId: string;
  name: string;
  rawArguments: string;
}): Promise<unknown> {
  try {
    if (options.actions.signal.aborted) return { ok: false, code: "voice_live_not_found", completion: "not_executed" };
    const args: unknown = JSON.parse(options.rawArguments);
    const { actions, service, requestId, observer } = options;
    switch (options.name) {
      case "clanky_find_operations":
        return service.find(actions.authority, schemas.clanky_find_operations.parse(args));
      case "clanky_describe_operation":
        return service.describe(actions.authority, schemas.clanky_describe_operation.parse(args).operationId);
      case "clanky_execute_operation": {
        const { confirmationDescription, ...input } = schemas.clanky_execute_operation.parse(args);
        return await actions.execute(input, requestId, confirmationDescription);
      }
      case "clanky_get_ui_state":
        schemas.clanky_get_ui_state.parse(args);
        return await actions.getUiState(requestId);
      case "clanky_ui_action":
        return await actions.uiAction(schemas.clanky_ui_action.parse(args).action, requestId);
      case "clanky_watch_work":
        return await observer.change(schemas.clanky_watch_work.parse(args));
      default:
        return { ok: false, code: "voice_tool_unavailable", message: "Discover a supported tool.", completion: "not_executed" };
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      log.warn("Invalid voice tool input", { tool: options.name });
      return { ok: false, code: "invalid_arguments", message: "Use the exact documented contract.", completion: "not_executed" };
    }
    if (isDomainError(error)) {
      log.warn("Voice tool rejected", { tool: options.name, code: error.code });
      return { ok: false, code: error.code, message: error.message, completion: "not_executed" };
    }
    throw error;
  }
}
