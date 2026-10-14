/**
 * Direct intent dispatch through canonical authorized public operations.
 */
import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import { ControlNavigationActionSchema } from "@/shared/clanky-control";
import { ExecutionHostRefSchema } from "@/contracts/schemas/execution-host";
import { getExecutionHostSourceId } from "@/shared/execution-host";
import { LiveVoiceDirectContext } from "./live-voice-direct-context";
import { liveVoiceDirectSchemas, type DirectToolName } from "./live-voice-direct-contracts";
import { directList, directOverview, directRead, directServers, pendingInteractions } from "./live-voice-direct-reads";
import { directCreateChat, directCreateTask, directCreateWorkspace } from "./live-voice-direct-creation";

export const LiveVoiceNavigationActionSchema = z.discriminatedUnion("type", [
  ...ControlNavigationActionSchema.options,
  z.object({
    type: z.literal("open_named"), kind: z.enum(["chat", "task", "workspace", "server", "host"]),
    target: z.string().trim().min(1).max(500),
    workspace: z.string().trim().min(1).max(500).nullable().default(null),
  }).strict(),
]);

export function isDirectToolName(name: string): name is DirectToolName {
  return Object.hasOwn(liveVoiceDirectSchemas, name);
}

export async function directUiAction(context: LiveVoiceDirectContext, value: unknown): Promise<unknown> {
  const action = LiveVoiceNavigationActionSchema.parse(value);
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

export async function executeDirectLiveVoiceTool(context: LiveVoiceDirectContext, name: DirectToolName, args: unknown): Promise<unknown> {
  switch (name) {
    case "clanky_recent_work":
      return await directOverview(context, false, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_waiting_work":
      return await directOverview(context, true, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_list_chats":
      return await directList(context, "chat", liveVoiceDirectSchemas[name].parse(args));
    case "clanky_list_tasks":
      return await directList(context, "task", liveVoiceDirectSchemas[name].parse(args));
    case "clanky_read_chat":
      return await directRead(context, "chat", liveVoiceDirectSchemas[name].parse(args));
    case "clanky_read_task":
      return await directRead(context, "task", liveVoiceDirectSchemas[name].parse(args));
    case "clanky_create_chat":
      return await directCreateChat(context, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_create_task":
      return await directCreateTask(context, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_create_workspace":
      return await directCreateWorkspace(context, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_list_workspaces": {
      const input = liveVoiceDirectSchemas[name].parse(args);
      return await context.read({
        operationId: "GET /api/workspaces", query: { limit: input.limit ?? 10, ...(input.cursor ? { cursor: input.cursor } : {}) },
      });
    }
    case "clanky_list_servers":
      return await directServers(context, liveVoiceDirectSchemas[name].parse(args));
    case "clanky_send_chat_message": {
      const input = liveVoiceDirectSchemas[name].parse(args);
      const id = String((await context.resolve("chat", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: "POST /api/chats/:id/messages", parameters: { id },
        body: { message: input.message, attachments: [] },
      });
    }
    case "clanky_interrupt_chat": {
      const input = liveVoiceDirectSchemas[name].parse(args);
      const id = String((await context.resolve("chat", input.target, input.workspace))["id"]);
      return await context.execute({ operationId: "POST /api/chats/:id/interrupt", parameters: { id }, body: {} });
    }
    case "clanky_respond_chat_interaction": {
      const input = liveVoiceDirectSchemas[name].parse(args);
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
      const input = liveVoiceDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: input.intent === "follow_up" ? "POST /api/tasks/:id/follow-up" : "PUT /api/tasks/:id/pending-prompt",
        parameters: { id }, body: input.intent === "follow_up"
          ? { message: input.message, model: null, attachments: [] } : { prompt: input.message, attachments: [] },
      });
    }
    case "clanky_control_task": {
      const input = liveVoiceDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: `POST /api/tasks/:id/${input.command === "start_planning" ? "draft/start" : "stop"}`,
        parameters: { id }, ...(input.command === "start_planning" ? { body: { attachments: [] } } : {}),
      });
    }
    case "clanky_review_task_plan": {
      const input = liveVoiceDirectSchemas[name].parse(args);
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
      const input = liveVoiceDirectSchemas[name].parse(args);
      const id = String((await context.resolve("task", input.target, input.workspace))["id"]);
      return await context.execute({
        operationId: `POST /api/tasks/:id/${input.action === "accept_local" ? "accept" : "push"}`,
        parameters: { id }, confirmationDescription: input.confirmationDescription,
      });
    }
  }
}
