import { z } from "zod";
import type { ControlToolDefinition } from "@/contracts/schemas/control";
import { contentReadPage, readBytes, readRevision } from "../client-sdk/collaboration/resource-read";
import { directUiAction, ControlNavigationIntentSchema } from "./control-direct-tools";
import type { ControlToolContext } from "./control-tool-context";

export const controlUiToolSchemas = {
  clanky_get_ui_state: z.object({
    section: z.enum(["route", "preferences"]).nullable().default(null),
    cursor: z.string().max(4096).nullable().default(null),
  }).strict(),
  clanky_ui_action: z.object({ action: ControlNavigationIntentSchema }).strict(),
};

export const controlUiToolDescriptions = {
  clanky_get_ui_state: "Read fresh acknowledged originating-client context, not authoritative entity state. Start with section/cursor null; use route/preferences sections and nextCursor if the snapshot is large. Preferences include saved planning booleans and canonical model JSON.",
  clanky_ui_action: "Navigate or control the originating client's sidebar. open_named resolves an exact chat/task/workspace/server/host name or ID directly, with optional workspace. Other actions use known canonical IDs. Returns success only after that tab acknowledges the effect. Never supplies confirmation approval.",
};

export const controlUiToolDefinitions: ControlToolDefinition[] = Object.entries(controlUiToolSchemas).map(([name, schema]) => ({
  name, description: controlUiToolDescriptions[name as keyof typeof controlUiToolSchemas],
  inputSchema: z.toJSONSchema(schema, { io: "input" }),
}));

export function isControlUiToolName(name: string): name is keyof typeof controlUiToolSchemas {
  return Object.hasOwn(controlUiToolSchemas, name);
}

export async function executeControlUiTool(context: ControlToolContext, name: keyof typeof controlUiToolSchemas, input: unknown): Promise<unknown> {
  if (name === "clanky_ui_action") {
    return await directUiAction(context, controlUiToolSchemas.clanky_ui_action.parse(input).action);
  }
  const { section, cursor } = controlUiToolSchemas.clanky_get_ui_state.parse(input);
  const outcome = await context.options.actions.getUiState(context.options.requestId);
  if (outcome.status !== "context") return outcome;
  if (!section && !cursor && readBytes(outcome) <= context.options.maxBytes) return outcome;
  if (!section) return { status: "context", revision: outcome.context.revision, sections: ["route", "preferences"] };
  const source = section === "route" ? outcome.context.route : {
    planningPreferences: outcome.context.planningPreferences ?? null,
    modelPreferences: outcome.context.modelPreferences ?? null,
  };
  return contentReadPage({
    source, options: { ...(cursor ? { cursor } : {}), maxBytes: context.options.maxBytes },
    scope: readRevision(["originating_ui", section]),
  });
}
