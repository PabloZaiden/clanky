/**
 * Application intents independent of provider, transport or voice orchestration.
 */
import { z } from "zod";
import { createLogger } from "@pablozaiden/webapp/server";
import { CONTROL_READ_BYTES, type ClankyOperationService } from "./clanky-operation-service";
import type { ControlActions } from "./control-actions";
import { ControlToolContext, type ControlToolOrigin } from "./control-tool-context";
import { executeDirectControlTool, isDirectToolName } from "./control-direct-tools";
import { controlToolSchemas } from "./control-tool-contracts";
import { isDomainError } from "../domain/domain-error";
import { isControlUiToolName, executeControlUiTool } from "./control-ui-tools";
import { agentNotificationService } from "./agent-notification-service";

const log = createLogger("core:control-tools");

export async function executeControlTool(options: {
  service: ClankyOperationService;
  actions: ControlActions;
  requestId: string;
  name: string;
  input: unknown;
  maxReadBytes?: number;
  origin?: ControlToolOrigin;
}): Promise<unknown> {
  try {
    const { actions, service, requestId, name, input } = options;
    if (actions.signal.aborted) {
      return { ok: false, code: "control_context_ended", completion: "not_executed" };
    }
    const maxBytes = options.maxReadBytes ?? CONTROL_READ_BYTES;
    const context = new ControlToolContext({ actions, service, requestId, maxBytes, origin: options.origin });
    if (isControlUiToolName(name)) return await executeControlUiTool(context, name, input);
    if (isDirectToolName(name)) return await executeDirectControlTool(context, name, input);
    switch (name) {
      case "clanky_send_notification":
        return await agentNotificationService.send(input, actions.signal);
      case "clanky_list_operations":
        controlToolSchemas.clanky_list_operations.parse(input);
        return service.list(actions.authority);
      case "clanky_find_operations":
        return service.find(actions.authority, controlToolSchemas.clanky_find_operations.parse(input), maxBytes);
      case "clanky_describe_operation": {
        const { operationId, section, cursor } = controlToolSchemas.clanky_describe_operation.parse(input);
        return service.describe(actions.authority, operationId, {
          maxBytes, ...(section ? { section } : {}), ...(cursor ? { cursor } : {}),
        });
      }
      case "clanky_execute_operation": {
        const { confirmationDescription, ...operation } = controlToolSchemas.clanky_execute_operation.parse(input);
        return await actions.execute(operation, { requestId, confirmationDescription, maxBytes });
      }
      default:
        log.warn("Unavailable control tool", { tool: name });
        return { ok: false, code: "control_tool_unavailable", message: "Use a supported tool.", completion: "not_executed" };
    }
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      log.warn("Invalid control tool input", { tool: options.name });
      return { ok: false, code: "invalid_arguments", message: "Use the exact documented contract.", completion: "not_executed" };
    }
    if (isDomainError(error)) {
      log.warn("Control tool rejected", { tool: options.name, code: error.code });
      return {
        ok: false, code: error.code, message: error.message, completion: "not_executed",
        ...(isDirectToolName(options.name) ? { details: error.details } : {}),
      };
    }
    throw error;
  }
}
