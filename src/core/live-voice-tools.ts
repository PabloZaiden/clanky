/**
 * Small model-facing tools for the user's global Clanky assistant.
 */

import { z } from "zod";
import type { ClankyOperationService } from "./clanky-operation-service";
import { LiveVoiceIntentionSchema } from "@/shared/live-voice";
import type { ControlActions } from "./control-actions";
import type { LiveVoiceObserver } from "./live-voice-observer";
import { isDomainError } from "../domain/domain-error";
import { createLogger } from "@pablozaiden/webapp/server";
import { LIVE_READ_BYTES } from "./live-voice-output";
import { controlToolSchemas, controlToolDescriptions, isControlToolName } from "./control-tool-contracts";
import { executeControlTool } from "./control-tools";
import { ControlToolContext } from "./control-tool-context";
import { controlUiToolSchemas, controlUiToolDescriptions, isControlUiToolName, executeControlUiTool } from "./control-ui-tools";

const log = createLogger("core:voice-tools");
export const LIVE_VOICE_SESSION_END_REQUEST = "voice_session_end_requested";
export const LIVE_VOICE_GOODBYE_GUIDANCE =
  "After a clear goodbye (such as 'chau', 'chao', 'adiós' or 'hasta luego') or a direct request to finish, immediately delegate to Responses with clanky_accept_goodbye as the only tool call. Do not speak before or after the delegation. Do not do this for an opening greeting or pause.";
export const LIVE_VOICE_GOODBYE_TOOL_GUIDANCE =
  "Call this tool alone after a clear goodbye (such as 'chau', 'chao', 'adiós' or 'hasta luego') or direct request to finish. Do not use it for an opening greeting or pause. After calling it, do not call another tool or produce additional speech.";
const schemas = {
  ...controlToolSchemas,
  ...controlUiToolSchemas,
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
  ...controlToolDescriptions,
  ...controlUiToolDescriptions,
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
  actions: ControlActions;
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
    const direct = new ControlToolContext({ actions, service, requestId, maxBytes });
    if (isControlToolName(options.name)) return await executeControlTool({
      service, actions, requestId, name: options.name, input: args, maxReadBytes: maxBytes,
    });
    if (isControlUiToolName(options.name)) return await executeControlUiTool(direct, options.name, args);
    switch (options.name) {
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
        ...(options.name === "clanky_ui_action" ? { details: error.details } : {}),
      };
    }
    throw error;
  }
}
