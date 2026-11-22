import { z } from "zod";
import type { ControlToolDefinition } from "@/contracts/schemas/control";
import { ClientPerformanceDetailSchema } from "@/shared/client-performance-stats";
import { contentReadPage, readBytes, readRevision } from "../client-sdk/collaboration/resource-read";
import { directUiAction, ControlNavigationIntentSchema } from "./control-direct-tools";
import type { ControlToolContext } from "./control-tool-context";

export const controlUiToolSchemas = {
  clanky_get_ui_state: z.object({
    section: z.literal("route").nullable().default(null),
    cursor: z.string().max(4096).nullable().default(null),
  }).strict(),
  clanky_ui_action: z.object({ action: ControlNavigationIntentSchema }).strict(),
  clanky_get_client_performance_stats: z.object({
    detail: ClientPerformanceDetailSchema.default("summary"),
  }).strict(),
};

export const controlUiToolDescriptions = {
  clanky_get_ui_state: "Read fresh acknowledged originating-client navigation context, not authoritative entity state. Start with section/cursor null; use the route section and nextCursor if the snapshot is large.",
  clanky_ui_action: "Navigate or control the originating client's sidebar. open_named resolves an exact chat/workspace/host name or ID directly, with optional workspace. Other actions use known canonical IDs. Returns success only after that tab acknowledges the effect. Never supplies confirmation approval.",
  clanky_get_client_performance_stats: "Only on user request, read already enabled Performance Stats from this chat turn's originating client tab. Use summary first; recent returns bounded individual timing samples. Does not enable capture. sampleCount is the retained count; discarded counts samples dropped by the capture limit.",
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
  if (name === "clanky_get_client_performance_stats") {
    const { detail } = controlUiToolSchemas[name].parse(input);
    const outcome = await context.options.actions.getClientPerformanceStats(detail, context.options.requestId);
    if (outcome.status !== "performance_stats") {
      return { status: "unavailable", ...(outcome.status === "failed" ? { code: outcome.code } : {}) };
    }
    const { stats } = outcome;
    if (stats.state !== "captured") return stats;
    const result = { ...stats, samples: [...stats.samples] };
    while (result.samples.length > 0 && readBytes(result) > context.options.maxBytes) result.samples.shift();
    return result;
  }
  const { section, cursor } = controlUiToolSchemas.clanky_get_ui_state.parse(input);
  const outcome = await context.options.actions.getUiState(context.options.requestId);
  if (outcome.status !== "context") return outcome;
  if (!section && !cursor && readBytes(outcome) <= context.options.maxBytes) return outcome;
  if (!section) return { status: "context", revision: outcome.context.revision, sections: ["route"] };
  const source = outcome.context.route;
  return contentReadPage({
    source, options: { ...(cursor ? { cursor } : {}), maxBytes: context.options.maxBytes },
    scope: readRevision(["originating_ui", section]),
  });
}
