/**
 * Shared API-backed tools for native Codex and Copilot control chats.
 */

import { z } from "zod";
import type { ClankyControlContext, ControlUiAction } from "@/shared/clanky-control";

const MAX_RESPONSE_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;

async function readResponseBodyLimited(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export type ControlToolJsonValue =
  | null
  | boolean
  | number
  | string
  | ControlToolJsonValue[]
  | { [key: string]: ControlToolJsonValue };

type ControlToolJsonSchema = Record<string, ControlToolJsonValue>;

export type ClankyControlToolResult =
  | { ok: true; status: number; data: unknown }
  | { ok: false; error: { code: string; message: string; status?: number } };

interface ControlToolDefinition {
  name: string;
  description: string;
  inputSchema: ControlToolJsonSchema;
  invoke(
    api: ClankyControlApiClient,
    input: unknown,
    context: ClankyControlContext,
    signal?: AbortSignal,
  ): Promise<ClankyControlToolResult>;
}

export class ClankyControlApiClient {
  private readonly baseUrl: URL;
  private readonly apiKey: string;

  constructor(environment: Record<string, string | undefined>) {
    const baseUrl = environment["CLANKY_BASE_URL"]?.trim();
    const apiKey = environment["CLANKY_API_KEY"]?.trim();
    if (!baseUrl || !apiKey) {
      throw new Error("Managed Clanky API credentials are required for control tools.");
    }

    this.baseUrl = new URL(baseUrl);
    if (
      (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:")
      || this.baseUrl.username
      || this.baseUrl.password
      || this.baseUrl.search
      || this.baseUrl.hash
    ) {
      throw new Error("The managed Clanky API base URL is invalid.");
    }
    this.apiKey = apiKey;
  }

  async request(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<ClankyControlToolResult> {
    if (!path.startsWith("/api/") || path.startsWith("//")) {
      return toolFailure("invalid_api_path", "Clanky tools can only call same-origin /api routes.");
    }

    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      return toolFailure("invalid_api_path", "Clanky tools can only call same-origin /api routes.");
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers = new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        Origin: this.baseUrl.origin,
      });
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      if (body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseBody = await readResponseBodyLimited(response);
      if (responseBody === null) {
        return toolFailure("clanky_response_too_large", "The Clanky API response exceeds the tool output limit.", response.status);
      }

      let data: unknown = responseBody;
      if (!responseBody.trim()) {
        data = null;
      } else {
        try {
          data = JSON.parse(responseBody) as unknown;
        } catch {
          if (response.ok) {
            data = responseBody;
          } else {
            return toolFailure("clanky_api_error", `Clanky returned HTTP ${response.status}.`, response.status);
          }
        }
      }

      if (!response.ok) {
        return getApiFailure(data, response.status);
      }
      return { ok: true, status: response.status, data };
    } catch (error) {
      if (controller.signal.aborted) {
        return toolFailure(
          options.signal?.aborted ? "control_tool_cancelled" : "clanky_api_timeout",
          options.signal?.aborted ? "The control tool was cancelled." : "The Clanky API request timed out.",
        );
      }
      return toolFailure("clanky_api_unavailable", "The Clanky API request could not be completed.");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}

function getApiFailure(data: unknown, status: number): ClankyControlToolResult {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const body = data as Record<string, unknown>;
    return toolFailure(
      typeof body["error"] === "string" ? body["error"] : "clanky_api_error",
      typeof body["message"] === "string" ? body["message"] : `Clanky returned HTTP ${status}.`,
      status,
    );
  }
  return toolFailure("clanky_api_error", `Clanky returned HTTP ${status}.`, status);
}

function toolFailure(code: string, message: string, status?: number): ClankyControlToolResult {
  return { ok: false, error: { code, message, ...(status === undefined ? {} : { status }) } };
}

function objectSchema(properties: Record<string, ControlToolJsonValue>, required: string[] = []): ControlToolJsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function defineControlTool<TSchema extends z.ZodType>(
  name: string,
  description: string,
  schema: TSchema,
  inputSchema: ControlToolJsonSchema,
  execute: (
    api: ClankyControlApiClient,
    input: z.infer<TSchema>,
    context: ClankyControlContext,
    signal?: AbortSignal,
  ) => Promise<ClankyControlToolResult>,
): ControlToolDefinition {
  return {
    name,
    description,
    inputSchema,
    async invoke(api, input, context, signal) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean))];
        return toolFailure(
          "invalid_tool_arguments",
          fields.length > 0 ? `Invalid tool arguments: ${fields.join(", ")}.` : "Invalid tool arguments.",
        );
      }
      return await execute(api, parsed.data, context, signal);
    },
  };
}

function defineUiActionTool<TSchema extends z.ZodType>(
  name: string,
  description: string,
  schema: TSchema,
  inputSchema: ControlToolJsonSchema,
  action: (input: z.infer<TSchema>) => ControlUiAction,
): ControlToolDefinition {
  return defineControlTool(name, description, schema, inputSchema, async (api, input, context, signal) => {
    if (!context.clientId) {
      return toolFailure(
        "control_client_unavailable",
        "This command needs an originating browser tab; send it from the Clanky interface.",
      );
    }
    return await api.request("POST", "/api/control/ui-actions", {
      body: {
        chatId: context.chatId,
        clientId: context.clientId,
        turnId: context.turnId,
        action: action(input),
      },
      signal,
    });
  });
}

const IdSchema = z.string().trim().min(1).max(500);
const ModelSchema = z.object({
  providerID: IdSchema,
  modelID: IdSchema,
  variant: z.string().max(1000).optional(),
}).strict();
const EmptyInputSchema = z.object({}).strict();
const noArguments = objectSchema({});

const CONTROL_TOOLS: ControlToolDefinition[] = [
  defineControlTool(
    "clanky_list_workspaces",
    "List the user's Clanky workspaces. Use this to find a workspace by name before operating on it.",
    EmptyInputSchema,
    noArguments,
    async (api, _input, _context, signal) => await api.request("GET", "/api/workspaces", { signal }),
  ),
  defineControlTool(
    "clanky_list_chats",
    "List the user's chats, optionally filtered by workspaceId. Inspect chat state for status and pending questions.",
    z.object({ workspaceId: IdSchema.optional() }).strict(),
    objectSchema({ workspaceId: { type: "string", minLength: 1 } }),
    async (api, input, _context, signal) => {
      const query = input.workspaceId ? `?workspaceId=${encodeURIComponent(input.workspaceId)}` : "";
      return await api.request("GET", `/api/chats${query}`, { signal });
    },
  ),
  defineControlTool(
    "clanky_get_chat",
    "Read one chat's current status, pending interactions, queued messages, and summary.",
    z.object({ chatId: IdSchema }).strict(),
    objectSchema({ chatId: { type: "string", minLength: 1 } }, ["chatId"]),
    async (api, input, _context, signal) => await api.request(
      "GET",
      `/api/chats/${encodeURIComponent(input.chatId)}`,
      { signal },
    ),
  ),
  defineControlTool(
    "clanky_get_chat_activity",
    "Read native activity for a chat, including running child work when its provider supports observation.",
    z.object({ chatId: IdSchema }).strict(),
    objectSchema({ chatId: { type: "string", minLength: 1 } }, ["chatId"]),
    async (api, input, _context, signal) => await api.request(
      "GET",
      `/api/chats/${encodeURIComponent(input.chatId)}/activity`,
      { signal },
    ),
  ),
  defineControlTool(
    "clanky_read_chat_snapshot",
    "Read the latest chat transcript snapshot. Use the chat state endpoint for current status and pending questions.",
    z.object({ chatId: IdSchema }).strict(),
    objectSchema({ chatId: { type: "string", minLength: 1 } }, ["chatId"]),
    async (api, input, _context, signal) => await api.request(
      "GET",
      `/api/chats/${encodeURIComponent(input.chatId)}/snapshot`,
      { signal },
    ),
  ),
  defineControlTool(
    "clanky_read_workspace_file",
    "Read a file through Clanky's file API and the selected workspace host. Do not use this to modify another workspace.",
    z.object({
      workspaceId: IdSchema,
      path: z.string().trim().min(1).max(16_384),
    }).strict(),
    objectSchema({
      workspaceId: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
    }, ["workspaceId", "path"]),
    async (api, input, _context, signal) => await api.request(
      "GET",
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/files/content?path=${encodeURIComponent(input.path)}`,
      { signal },
    ),
  ),
  defineControlTool(
    "clanky_get_workspace_settings",
    "Read the effective, nonsensitive settings for a workspace.",
    z.object({ workspaceId: IdSchema }).strict(),
    objectSchema({ workspaceId: { type: "string", minLength: 1 } }, ["workspaceId"]),
    async (api, input, _context, signal) => await api.request(
      "GET",
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/server-settings`,
      { signal },
    ),
  ),
  defineControlTool(
    "clanky_update_workspace_settings",
    "Update a workspace's server settings using the Clanky settings schema.",
    z.object({
      workspaceId: IdSchema,
      settings: z.record(z.string(), z.unknown()),
    }).strict(),
    objectSchema({
      workspaceId: { type: "string", minLength: 1 },
      settings: { type: "object", additionalProperties: true },
    }, ["workspaceId", "settings"]),
    async (api, input, _context, signal) => await api.request(
      "PUT",
      `/api/workspaces/${encodeURIComponent(input.workspaceId)}/server-settings`,
      { body: input.settings, signal },
    ),
  ),
  defineControlTool(
    "clanky_get_quick_chat_settings",
    "Read the user's Quick Chat workspace, model, and worktree preferences.",
    EmptyInputSchema,
    noArguments,
    async (api, _input, _context, signal) => await api.request("GET", "/api/preferences/quick-chat", { signal }),
  ),
  defineControlTool(
    "clanky_update_quick_chat_settings",
    "Update all Quick Chat preferences. Provide the complete workspaceId, model, and useWorktree values.",
    z.object({
      workspaceId: z.string().max(500),
      model: ModelSchema.nullable(),
      useWorktree: z.boolean(),
    }).strict(),
    objectSchema({
      workspaceId: { type: "string" },
      model: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            properties: {
              providerID: { type: "string" },
              modelID: { type: "string" },
              variant: { type: "string" },
            },
            required: ["providerID", "modelID"],
            additionalProperties: false,
          },
        ],
      },
      useWorktree: { type: "boolean" },
    }, ["workspaceId", "model", "useWorktree"]),
    async (api, input, _context, signal) => await api.request(
      "PUT",
      "/api/preferences/quick-chat",
      { body: input, signal },
    ),
  ),
  defineControlTool(
    "clanky_create_chat",
    "Create a normal chat in a workspace. Defaults to this control chat's workspace and model. To ask another chat to do repository work, send it a message instead of running Git here.",
    z.object({
      workspaceId: IdSchema.optional(),
      name: z.string().trim().max(100).optional(),
      model: ModelSchema.optional(),
      useWorktree: z.boolean().optional(),
    }).strict(),
    objectSchema({
      workspaceId: { type: "string", minLength: 1 },
      name: { type: "string", maxLength: 100 },
      model: {
        type: "object",
        properties: {
          providerID: { type: "string", minLength: 1 },
          modelID: { type: "string", minLength: 1 },
          variant: { type: "string" },
        },
        required: ["providerID", "modelID"],
        additionalProperties: false,
      },
      useWorktree: { type: "boolean" },
    }),
    async (api, input, context, signal) => {
      const model = input.model ?? context.defaultModel;
      return await api.request("POST", "/api/chats", {
        body: {
          workspaceId: input.workspaceId ?? context.workspaceId,
          model,
          useWorktree: input.useWorktree ?? true,
          autoApprovePermissions: true,
          quick: false,
          ...(input.name ? { name: input.name } : {}),
        },
        signal,
      });
    },
  ),
  defineControlTool(
    "clanky_send_message_to_chat",
    "Send an instruction to another chat. This delegates repository work to that chat and its selected host; never execute Git directly against another workspace.",
    z.object({
      chatId: IdSchema,
      message: z.string().trim().min(1).max(100_000),
    }).strict(),
    objectSchema({
      chatId: { type: "string", minLength: 1 },
      message: { type: "string", minLength: 1 },
    }, ["chatId", "message"]),
    async (api, input, _context, signal) => await api.request(
      "POST",
      `/api/chats/${encodeURIComponent(input.chatId)}/messages`,
      { body: { message: input.message }, signal },
    ),
  ),
  defineControlTool(
    "clanky_answer_chat_question",
    "Answer a pending question in a chat on behalf of the user.",
    z.object({
      chatId: IdSchema,
      requestId: IdSchema,
      answers: z.array(z.array(z.string().min(1).max(10_000)).max(100)).min(1).max(100),
    }).strict(),
    objectSchema({
      chatId: { type: "string", minLength: 1 },
      requestId: { type: "string", minLength: 1 },
      answers: { type: "array", items: { type: "array", items: { type: "string" } } },
    }, ["chatId", "requestId", "answers"]),
    async (api, input, _context, signal) => await api.request(
      "POST",
      `/api/chats/${encodeURIComponent(input.chatId)}/questions/${encodeURIComponent(input.requestId)}`,
      { body: { answers: input.answers }, signal },
    ),
  ),
  defineControlTool(
    "clanky_get_server_logs",
    "Read the in-memory Clanky server log snapshot when the caller has admin access.",
    EmptyInputSchema,
    noArguments,
    async (api, _input, _context, signal) => await api.request("GET", "/api/server/logs", { signal }),
  ),
  defineUiActionTool(
    "clanky_open_workspace",
    "Open a workspace in this user's Clanky interface. This navigates only the tab that sent the current control-chat turn.",
    z.object({ workspaceId: IdSchema }).strict(),
    objectSchema({ workspaceId: { type: "string", minLength: 1 } }, ["workspaceId"]),
    (input) => ({ type: "open_workspace", workspaceId: input.workspaceId }),
  ),
  defineUiActionTool(
    "clanky_open_workspace_file",
    "Open a workspace file in this user's Clanky interface. The file is loaded by that workspace's host; success is returned only after the target tab confirms it opened.",
    z.object({
      workspaceId: IdSchema,
      filePath: z.string().trim().min(1).max(16_384),
    }).strict(),
    objectSchema({
      workspaceId: { type: "string", minLength: 1 },
      filePath: { type: "string", minLength: 1 },
    }, ["workspaceId", "filePath"]),
    (input) => ({
      type: "open_workspace_file",
      workspaceId: input.workspaceId,
      filePath: input.filePath,
    }),
  ),
  defineUiActionTool(
    "clanky_open_chat",
    "Open a chat in this user's Clanky interface. This navigates only the tab that sent the current control-chat turn.",
    z.object({ chatId: IdSchema }).strict(),
    objectSchema({ chatId: { type: "string", minLength: 1 } }, ["chatId"]),
    (input) => ({ type: "open_chat", chatId: input.chatId }),
  ),
];

export class ClankyControlToolService {
  readonly definitions = CONTROL_TOOLS;
  readonly api: ClankyControlApiClient;
  private readonly toolsByName = new Map(CONTROL_TOOLS.map((tool) => [tool.name, tool]));

  constructor(environment: Record<string, string | undefined>) {
    this.api = new ClankyControlApiClient(environment);
  }

  async invoke(
    name: string,
    input: unknown,
    context: ClankyControlContext | undefined,
    signal?: AbortSignal,
  ): Promise<ClankyControlToolResult> {
    if (!context?.chatId || !context.turnId || !context.workspaceId) {
      return toolFailure("control_context_unavailable", "The control tool call is not correlated with an active chat turn.");
    }
    const tool = this.toolsByName.get(name);
    if (!tool) {
      return toolFailure("unknown_control_tool", "The requested Clanky tool is not available.");
    }
    return await tool.invoke(this.api, input, context, signal);
  }
}
