/**
 * Shared direct intent dispatch through canonical authorized operations.
 */
import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import { ControlNavigationActionSchema } from "@/shared/clanky-control";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";
import { directRecord, ControlToolContext } from "./control-tool-context";
import { isReadRecord } from "../client-sdk/collaboration/resource-read";
import { controlDirectSchemas, type DirectToolName } from "./control-tool-contracts";
import { directList, directOverview, directRead, directServers, pendingInteractions } from "./control-direct-reads";
import { directCreateChat, directCreateTask, directCreateWorkspace } from "./control-direct-creation";

export const ControlNavigationIntentSchema = z.discriminatedUnion("type", [
  ...ControlNavigationActionSchema.options,
  z.object({
    type: z.literal("open_named"), kind: z.enum(["chat", "task", "workspace", "server", "host"]),
    target: z.string().trim().min(1).max(500),
    workspace: z.string().trim().min(1).max(500).nullable().default(null),
  }).strict(),
]);

export function isDirectToolName(name: string): name is DirectToolName {
  return Object.hasOwn(controlDirectSchemas, name);
}

export async function directUiAction(context: ControlToolContext, value: unknown): Promise<unknown> {
  const action = ControlNavigationIntentSchema.parse(value);
  if (action.type !== "open_named") return await context.options.actions.uiAction(action, context.options.requestId);
  if (action.kind === "host") {
    const host = await context.host(action.target);
    const ref = ExecutionHostRefSchema.parse(host["ref"]);
    return await context.options.actions.uiAction({
      type: "open_execution_host", kind: ref.kind, id: getExecutionHostSourceId(ref),
    }, context.options.requestId);
  }
  const target = await context.resolve(action.kind, action.target, action.workspace);
  const id = String(target["id"]);
  const canonical = action.kind === "chat" ? { type: "open_chat" as const, chatId: id }
    : action.kind === "task" ? { type: "open_task" as const, taskId: id }
      : action.kind === "workspace" ? { type: "open_workspace" as const, workspaceId: id }
        : { type: "open_ssh_server" as const, serverId: id };
  return await context.options.actions.uiAction(canonical, context.options.requestId);
}

export async function executeDirectControlTool(context: ControlToolContext, name: DirectToolName, args: unknown): Promise<unknown> {
  switch (name) {
    case "clanky_recent_work":
      return await directOverview(context, false, controlDirectSchemas[name].parse(args));
    case "clanky_waiting_work":
      return await directOverview(context, true, controlDirectSchemas[name].parse(args));
    case "clanky_list_chats":
      return await directList(context, "chat", controlDirectSchemas[name].parse(args));
    case "clanky_list_tasks":
      return await directList(context, "task", controlDirectSchemas[name].parse(args));
    case "clanky_read_chat":
      return await directRead(context, "chat", controlDirectSchemas[name].parse(args));
    case "clanky_read_task":
      return await directRead(context, "task", controlDirectSchemas[name].parse(args));
    case "clanky_create_chat":
      return await directCreateChat(context, controlDirectSchemas[name].parse(args));
    case "clanky_create_task":
      return await directCreateTask(context, controlDirectSchemas[name].parse(args));
    case "clanky_create_workspace":
      return await directCreateWorkspace(context, controlDirectSchemas[name].parse(args));
    case "clanky_list_workspaces": {
      const input = controlDirectSchemas[name].parse(args);
      return await context.read({
        operationId: "GET /api/workspaces", query: { limit: input.limit ?? 10, ...(input.cursor ? { cursor: input.cursor } : {}) },
      });
    }
    case "clanky_list_servers":
      return await directServers(context, controlDirectSchemas[name].parse(args));
    case "clanky_send_chat_message": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("chat", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: "POST /api/chats/:id/messages", parameters: { id },
        body: { message: input.message, attachments: [] },
      });
    }
    case "clanky_steer_queued_chat_message": {
      const input = controlDirectSchemas[name].parse(args);
      const target = await context.resolve("chat", input.target, input.workspace);
      const id = String(target["id"]);
      const chat = directRecord(await context.readExact("GET /api/chats/:id", { id }));
      const state = directRecord(chat["state"]);
      const rawQueued = state["queuedMessages"];
      if (rawQueued !== undefined && !Array.isArray(rawQueued)) {
        throw new DomainError("voice_operation_response", "The chat returned an invalid queued-message list.");
      }
      const queued = (rawQueued ?? []).map((value: unknown) => {
        const message = directRecord(value);
        if (typeof message["id"] !== "string" || typeof message["content"] !== "string") {
          throw new DomainError("voice_operation_response", "The chat returned an invalid queued message.");
        }
        return {
          id: message["id"],
          content: message["content"],
          ...(typeof message["createdAt"] === "string" ? { createdAt: message["createdAt"] } : {}),
        };
      });
      if (new Set(queued.map((message: { id: string }) => message.id)).size !== queued.length) {
        throw new DomainError("voice_operation_response", "The chat returned duplicate queued-message IDs.");
      }
      let selected = input.messageId
        ? queued.find((message: { id: string }) => message.id === input.messageId)
        : undefined;
      if (input.messageId && !selected) {
        throw new DomainError("voice_queued_message_not_found", "That queued message is no longer available.");
      }
      if (!input.messageId) {
        if (!queued.length) {
          throw new DomainError("voice_queued_message_not_found", "The chat has no queued message to steer.");
        }
        if (queued.length > 1) {
          const candidates = queued.slice(-8).map((message: { id: string; content: string; createdAt?: string }) => ({
            messageId: message.id,
            content: message.content.slice(0, 160),
            ...(message.createdAt ? { createdAt: message.createdAt } : {}),
          }));
          throw new DomainError("voice_queued_message_ambiguous", "Choose one queued message before steering.", {
            details: { candidates, omitted: Math.max(0, queued.length - candidates.length) },
          });
        }
        selected = queued[0];
      }
      const result = directRecord(await context.execute({
        operationId: "POST /api/chats/:id/queued-messages/:messageId/steer",
        parameters: { id, messageId: selected!.id },
      }));
      if (result["ok"] !== true) {
        const error = result["data"] && typeof result["data"] === "object"
          && !Array.isArray(result["data"]) ? directRecord(result["data"]) : undefined;
        return context.bounded({
          ok: false,
          ...(typeof result["operationId"] === "string" ? { operationId: result["operationId"] } : {}),
          ...(typeof result["completion"] === "string" ? { completion: result["completion"] } : {}),
          ...(typeof result["status"] === "number" ? { status: result["status"] } : {}),
          ...(typeof result["code"] === "string" ? { code: result["code"] }
            : typeof error?.["error"] === "string" ? { code: error["error"] } : {}),
          ...(typeof result["message"] === "string" ? { message: result["message"] }
            : typeof error?.["message"] === "string" ? { message: error["message"] } : {}),
        });
      }
      const responseValue = result["data"];
      const response = isReadRecord(responseValue) ? responseValue : undefined;
      if (response?.["dataAvailable"] === false) {
        return context.bounded({
          ok: true,
          ...(typeof result["operationId"] === "string" ? { operationId: result["operationId"] } : {}),
          ...(typeof result["completion"] === "string" ? { completion: result["completion"] } : {}),
          ...(typeof result["status"] === "number" ? { status: result["status"] } : {}),
          data: {
            chatId: id,
            ...(typeof target["name"] === "string" ? { chatName: target["name"] } : {}),
            messageId: selected!.id,
            resultCode: typeof response["resultCode"] === "string"
              ? response["resultCode"] : "read_result_requires_targeted_read",
            dataAvailable: false,
            message: typeof response["message"] === "string"
              ? response["message"]
              : "The steering operation succeeded, but its receipt was omitted. Inspect the chat; do not repeat the mutation.",
          },
        });
      }
      const receipt = directRecord(responseValue);
      const admission = directRecord(receipt["admission"]);
      if (receipt["success"] !== true || typeof admission["status"] !== "string" || admission["inputId"] !== selected!.id) {
        throw new DomainError("voice_operation_response", "The queued-message steer returned an invalid admission.");
      }
      return context.bounded({
        ok: true,
        ...(typeof result["operationId"] === "string" ? { operationId: result["operationId"] } : {}),
        ...(typeof result["completion"] === "string" ? { completion: result["completion"] } : {}),
        data: {
          chatId: id,
          ...(typeof target["name"] === "string" ? { chatName: target["name"] } : {}),
          messageId: selected!.id,
          admission: {
            status: admission["status"],
            inputId: admission["inputId"],
            ...(typeof admission["code"] === "string" ? { code: admission["code"] } : {}),
          },
        },
      });
    }
    case "clanky_interrupt_chat": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("chat", input.target, input.workspace))["id"]);
      return await context.execute({ operationId: "POST /api/chats/:id/interrupt", parameters: { id }, body: {} });
    }
    case "clanky_update_chat_lifecycle": {
      const input = controlDirectSchemas[name].parse(args);
      if (input.action === "move_to_trash" && !input.confirmationDescription) {
        throw new DomainError(
          "voice_confirmation_description_required",
          "Describe the named chat and its recoverable Trash behavior before preparing this deletion.",
        );
      }
      const target = await context.resolve("chat", input.target, input.workspace);
      const id = String(target["id"]);
      const chat = directRecord(await context.readExact("GET /api/chats/:id", { id }));
      const config = directRecord(chat["config"]);
      if (config["scope"] !== "workspace" || config["taskId"] !== undefined) {
        throw new DomainError(
          "voice_chat_lifecycle_unsupported",
          "Live voice lifecycle actions are available only for standalone chats; task chats are managed by their task and agent chats are not supported.",
        );
      }
      if (input.action === "mark_done") {
        return await context.execute({
          operationId: "POST /api/chats/:id/done",
          parameters: { id },
        });
      }
      return await context.execute({
        operationId: "DELETE /api/chats/:id",
        parameters: { id },
        confirmationDescription: input.confirmationDescription,
      });
    }
    case "clanky_respond_chat_interaction": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("chat", input.target, input.workspace))["id"]);
      if (input.kind === "question" ? !input.answers || input.decision !== null : !input.decision || input.answers !== null) {
        throw new DomainError("voice_interaction_invalid", "Supply answers only for a question, or a decision only for a permission.");
      }
      const pending = pendingInteractions(await context.readExact("GET /api/chats/:id", { id }))
        .filter((item) => item["kind"] === input.kind && (!input.requestId || (item["id"] ?? item["requestId"]) === input.requestId));
      if (pending.length !== 1) throw new DomainError("voice_interaction_ambiguous", "Choose one current pending interaction.", {
        details: { candidates: pending.slice(0, 8).map((item) => ({ kind: item["kind"], requestId: item["id"] ?? item["requestId"] })) },
      });
      const requestId = String(pending[0]!["id"] ?? pending[0]!["requestId"]);
      return await context.execute({
        operationId: `POST /api/chats/:id/${input.kind === "question" ? "questions" : "permissions"}/:requestId`,
        parameters: { id, requestId }, body: input.kind === "question" ? { answers: input.answers } : { decision: input.decision },
        confirmationDescription: input.confirmationDescription,
      });
    }
    case "clanky_instruct_task": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: input.intent === "follow_up" ? "POST /api/tasks/:id/follow-up" : "PUT /api/tasks/:id/pending-prompt",
        parameters: { id }, body: input.intent === "follow_up"
          ? { message: input.message, model: null, attachments: [] } : { prompt: input.message, attachments: [] },
      });
    }
    case "clanky_control_task": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: `POST /api/tasks/:id/${input.command === "start_planning" ? "draft/start" : "stop"}`,
        parameters: { id }, ...(input.command === "start_planning" ? { body: { attachments: [] } } : {}),
      });
    }
    case "clanky_review_task_plan": {
      const input = controlDirectSchemas[name].parse(args);
      if (input.action === "feedback" ? !input.feedback : input.feedback !== null) {
        throw new DomainError("voice_plan_action_invalid", "Feedback is required only for the feedback action.");
      }
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: `POST /api/tasks/:id/plan/${input.action}`, parameters: { id },
        ...(input.action === "feedback" ? { body: { feedback: input.feedback, attachments: [] } }
          : input.action === "accept" ? { body: { mode: "start_task" } } : {}),
        confirmationDescription: input.confirmationDescription,
      });
    }
    case "clanky_finish_task": {
      const input = controlDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: `POST /api/tasks/:id/${input.action === "accept_local" ? "accept" : "push"}`,
        parameters: { id }, confirmationDescription: input.confirmationDescription,
      });
    }
  }
}
