/**
 * Small model-facing tools for the user's global Clanky assistant.
 */

import { z } from "zod";
import { ExecuteOperationSchema, type ClankyOperationService } from "./clanky-operation-service";
import { LiveVoiceIntentionSchema, VoiceConfirmationDescriptionSchema } from "@/shared/live-voice";
import type { LiveVoiceActions } from "./live-voice-actions";
import type { LiveVoiceObserver } from "./live-voice-observer";
import { isDomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { contentReadPage, readBytes, readRevision } from "../client-sdk/collaboration/resource-read";
import { LIVE_READ_BYTES } from "./live-voice-output";
import { liveVoiceDirectSchemas, liveVoiceDirectDescriptions } from "./live-voice-direct-contracts";
import { LiveVoiceDirectContext } from "./live-voice-direct-context";
import { directUiAction, executeDirectLiveVoiceTool, isDirectToolName, LiveVoiceNavigationActionSchema } from "./live-voice-direct-tools";

const log = createLogger("core:voice-tools");
export const LIVE_VOICE_SESSION_END_REQUEST = "voice_session_end_requested";
export const LIVE_VOICE_GOODBYE_GUIDANCE =
  "After a clear goodbye (such as 'chau', 'chao', 'adiós' or 'hasta luego') or a direct request to finish, immediately delegate to Responses with clanky_accept_goodbye as the only tool call. Do not speak before or after the delegation. Do not do this for an opening greeting or pause.";
export const LIVE_VOICE_GOODBYE_TOOL_GUIDANCE =
  "Call this tool alone after a clear goodbye (such as 'chau', 'chao', 'adiós' or 'hasta luego') or direct request to finish. Do not use it for an opening greeting or pause. After calling it, do not call another tool or produce additional speech.";
const schemas = {
  ...liveVoiceDirectSchemas,
  clanky_find_operations: z.object({
    text: z.string().max(500),
    domain: z.string().max(100).nullable(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).nullable(),
    cursor: z.number().int().nonnegative().max(10_000).nullable(),
  }).strict(),
  clanky_describe_operation: z.object({
    operationId: z.string().min(1).max(500),
    section: z.enum(["overview", "query", "body"]).nullable().default(null),
    cursor: z.string().max(4096).nullable().default(null),
  }).strict(),
  clanky_execute_operation: ExecuteOperationSchema.extend({
    confirmationDescription: VoiceConfirmationDescriptionSchema.nullable(),
  }),
  clanky_get_ui_state: z.object({
    section: z.enum(["route", "preferences"]).nullable().default(null),
    cursor: z.string().max(4096).nullable().default(null),
  }).strict(),
  clanky_ui_action: z.object({ action: LiveVoiceNavigationActionSchema }).strict(),
  clanky_watch_work: z.object({
    command: z.enum(["add", "remove", "list"]),
    targets: z.array(z.object({
      kind: z.enum(["chat", "task", "provisioning"]),
      id: z.string().min(1).max(500),
    }).strict()).max(16),
  }).strict(),
  clanky_accept_goodbye: z.object({}).strict(),
};

const descriptions: Record<keyof typeof schemas, string> = {
  ...liveVoiceDirectDescriptions,
  clanky_find_operations: "Fallback only for intents not covered by a direct tool. Find authorized Clanky operations by words/domain/method. Empty text lists a page.",
  clanky_describe_operation: "Read the exact contract and risk/completion policy. Start with section/cursor null; if contractSections are returned, read query/body separately. Content parts identify JSON paths; continue with nextCursor until null to obtain the complete schema.",
  clanky_execute_operation: "Execute a described API operation with exact parameters/query and bodyJson (null without a body). Reads automatically select compact pages or literal conversation history. Follow nextCursor with the same read operation, filters and public body to read more; section=details and item read a row's original content. Content parts contain JSON paths and string offsets, not a generated summary. For policy confirm, supply confirmationDescription: one or two short plain-text sentences in the user's language describing the exact action, named target and material consequences. No API paths, technical identifiers, JSON or credentials. Use null for other policies. Mutations are never retried automatically. High-risk actions prepare a visual confirmation, not execution.",
  clanky_get_ui_state: "Read fresh acknowledged originating-client context, not authoritative entity state. Start with section/cursor null; use route/preferences sections and nextCursor if the snapshot is large. Preferences include saved planning booleans and canonical model JSON.",
  clanky_ui_action: "Navigate or control the originating client's sidebar. open_named resolves an exact chat/task/workspace/server/host name or ID directly, with optional workspace. Other actions use known canonical IDs. Returns success only after that tab acknowledges the effect. Never supplies confirmation approval.",
  clanky_watch_work: "Watch selected owned chats/tasks/provisioning jobs for meaningful state changes. Ending voice stops watching, not the work.",
  clanky_accept_goodbye: LIVE_VOICE_GOODBYE_TOOL_GUIDANCE,
};

export const liveVoiceToolDefinitions = Object.entries(schemas).map(([name, schema]) => {
  const modelSchema = name === "clanky_accept_goodbye" ? schema : schema.extend({
    intention: LiveVoiceIntentionSchema.describe(
      "A few words in the user's language describing this lookup or action in progress. Plain text, at most 80 characters; no credentials, API paths, JSON or claims of completion.",
    ),
  });
  const { $schema: _schema, ...parameters } = z.toJSONSchema(modelSchema, {
    override: ({ zodSchema, jsonSchema }) => {
      if (jsonSchema.type === "object" && jsonSchema.properties) {
        jsonSchema.required = Object.keys(jsonSchema.properties);
      }
      if (zodSchema instanceof z.ZodDiscriminatedUnion && jsonSchema.oneOf) {
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
  maxReadBytes?: number;
  onIntention?: (intention: string) => void;
}): Promise<unknown> {
  try {
    if (options.actions.signal.aborted) return { ok: false, code: "voice_live_not_found", completion: "not_executed" };
    let args: unknown = JSON.parse(options.rawArguments);
    if (args && typeof args === "object" && !Array.isArray(args) && "intention" in args) {
      const { intention, ...input } = args;
      const label = LiveVoiceIntentionSchema.parse(intention);
      options.onIntention?.(label);
      args = input;
    }
    const { actions, service, requestId, observer } = options;
    const maxBytes = options.maxReadBytes ?? LIVE_READ_BYTES;
    const direct = new LiveVoiceDirectContext({ actions, service, requestId, maxBytes });
    if (isDirectToolName(options.name)) return await executeDirectLiveVoiceTool(direct, options.name, args);
    switch (options.name) {
      case "clanky_find_operations":
        return service.find(actions.authority, schemas.clanky_find_operations.parse(args), maxBytes);
      case "clanky_describe_operation": {
        const { operationId, section, cursor } = schemas.clanky_describe_operation.parse(args);
        return service.describe(actions.authority, operationId, {
          maxBytes,
          ...(section ? { section } : {}), ...(cursor ? { cursor } : {}),
        });
      }
      case "clanky_execute_operation": {
        const { confirmationDescription, ...input } = schemas.clanky_execute_operation.parse(args);
        return await actions.execute(input, { requestId, confirmationDescription, maxBytes });
      }
      case "clanky_get_ui_state": {
        const { section, cursor } = schemas.clanky_get_ui_state.parse(args);
        const outcome = await actions.getUiState(requestId);
        if (outcome.status !== "context") return outcome;
        if (!section && !cursor && readBytes(outcome) <= maxBytes) return outcome;
        if (!section) {
          return { status: "context", revision: outcome.context.revision, sections: ["route", "preferences"] };
        }
        const source = section === "route" ? outcome.context.route : {
          planningPreferences: outcome.context.planningPreferences ?? null,
          modelPreferences: outcome.context.modelPreferences ?? null,
        };
        return contentReadPage({
          source, options: { ...(cursor ? { cursor } : {}), maxBytes },
          scope: readRevision(["originating_ui", section]),
        });
      }
      case "clanky_ui_action":
        return await directUiAction(direct, schemas.clanky_ui_action.parse(args).action);
      case "clanky_watch_work":
        return await observer.change(schemas.clanky_watch_work.parse(args));
      case "clanky_accept_goodbye":
        schemas.clanky_accept_goodbye.parse(args);
        return { ok: true, code: LIVE_VOICE_SESSION_END_REQUEST, completion: "admission" };
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
      return {
        ok: false, code: error.code, message: error.message, completion: "not_executed",
        ...(isDirectToolName(options.name) || options.name === "clanky_ui_action" ? { details: error.details } : {}),
      };
    }
    throw error;
  }
}
