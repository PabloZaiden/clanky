import { z } from "zod";
import {
  realtimeClientMessageSchema, realtimeInterestMatches,
  type RealtimeInterest, type RealtimeServerMessage, type ResourceRealtimeEvent,
} from "@pablozaiden/webapp/contracts";
import type { WebAppDuplex, WebAppDuplexHandlers, WebAppResourceUrl } from "@pablozaiden/webapp/web";
import {
  ChatDiffFileQuerySchema, CreateChatRequestSchema, CreateExecutionHostChatRequestSchema, SendChatMessageRequestSchema,
  DiscoverExecutionHostModelsRequestSchema,
} from "@/contracts/schemas/chat";
import {
  SetFileExplorerFullTreeRequestSchema,
  SetMarkdownRenderingRequestSchema, SetQuickChatSettingsRequestSchema,
} from "@/contracts/schemas/preferences";
import {
  GetFileExplorerFileRequestSchema, GetFileExplorerTreeRequestSchema, ListFileExplorerRequestSchema,
} from "@/contracts/schemas/file-explorer";
import { DEMO_CONTROLLER_ENDPOINT } from "./storage";
import {
  DEMO_DIFF, DEMO_DIFF_BASE, DEMO_DIRECTORY, DEMO_FILES, DEMO_HOST, DEMO_MODEL, DEMO_MODELS, DEMO_NOTIFICATIONS, DEMO_RELAYS, DEMO_VOICE, DEMO_WORKER,
  demoChat, demoConfig, demoMeshStatus, demoTerminal, demoTranscript, demoWorkspace,
} from "./data";
import { DemoTerminal } from "./terminal";
import type { Chat, ChatSnapshot, ExecutionHostDescriptor, HarnessActivitySnapshot, WorkspaceFileEntry, WorkspaceFileNode } from "@/shared";
import type { SubagentList } from "@/shared/subagent";
import type { CreateChatRequest } from "@/contracts";

class DemoError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function unsupported(): never {
  throw new DemoError(422, "demo_action_unavailable",
    "Demo: this action is not simulated. Explore the fictional workspace, files and chat diff, or create a chat and send a text message. No real operation was performed.");
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DemoError(400, "invalid_request", result.error.issues.map(issue => issue.message).join("; "));
  return result.data;
}

export class DemoController {
  private readonly now = new Date().toISOString();
  private readonly workspace = demoWorkspace(this.now);
  private readonly terminal = new DemoTerminal(demoTerminal(this.now), () => this.changed("terminal-sessions", "demo-terminal"));
  private readonly chats = new Map<string, Chat>([
    ["demo-chat", demoChat("demo-chat", "Demo: explore the observatory", this.now)],
    ["demo-host-chat", demoChat("demo-host-chat", "Demo: server conversation", this.now, DEMO_WORKER)],
  ]);
  private readonly connections = new Set<{ publish(event: ResourceRealtimeEvent): void; close(): Promise<void> }>();
  private readonly urls = new Set<string>();
  private readonly preferences = new Map<string, unknown>([
    ["theme", { theme: "dark" }], ["markdown-rendering", { enabled: true }],
    ["file-explorer-full-tree", { enabled: true }],
    ["quick-chat", { workspaceId: "demo-workspace", model: DEMO_MODEL, useWorktree: false }],
    ["last-model", DEMO_MODEL],
    ["prompt-templates", { templates: [], planningTemplateEnabled: true, planningTemplateIndex: 0 }], ["sidebar-pins", { pins: [] }],
    ["scheduler-timezone", { timezone: "UTC" }], ["github-username", { githubUsername: "" }],
  ]);
  private disposed = false;

  private changed(resource: string, id?: string): void {
    const event: ResourceRealtimeEvent = { type: `${resource}.changed`, resource, action: "changed", ...(id ? { id } : {}) };
    for (const connection of this.connections) connection.publish(event);
  }

  async request(request: Request): Promise<Response> {
    request.signal.throwIfAborted();
    try {
      if (this.disposed) throw new DemoError(410, "demo_ended", "Demo: this session has ended. Reconnect to start again.");
      const url = new URL(request.url);
      if (url.origin !== DEMO_CONTROLLER_ENDPOINT || url.username || url.password) unsupported();
      const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      request.signal.throwIfAborted();
      if (new TextEncoder().encode(text).length > 64_000) throw new DemoError(413, "demo_input_limit", "Demo: use a shorter text message (at most 64 KB).");
      const body: unknown = text ? JSON.parse(text) : {};
      const headers = new Headers({ "cache-control": "no-store" });
      if (/\/chats\/[^/]+\/diff$/.test(url.pathname)) {
        headers.set("X-Clanky-Diff-Base", DEMO_DIFF_BASE);
        headers.set("X-Clanky-Diff-Base-Ref", "main");
      }
      return Response.json(this.dispatch(url, request.method, body), { headers });
    } catch (error) {
      request.signal.throwIfAborted();
      if (error instanceof DemoError) return Response.json({ error: error.code, message: error.message }, { status: error.status });
      if (error instanceof SyntaxError) return Response.json({ error: "invalid_json", message: "Demo: the request must contain valid JSON." }, { status: 400 });
      throw error;
    }
  }

  private dispatch(url: URL, method: string, body: unknown): unknown {
    const path = url.pathname;
    if (method === "GET") {
      switch (path) {
        case "/api/config": return demoConfig();
        case "/api/voice/settings": return DEMO_VOICE;
        case "/api/preferences/notifications": return DEMO_NOTIFICATIONS;
        case "/api/mesh/status": return demoMeshStatus(this.now);
        case "/api/mesh/relay": return DEMO_RELAYS;
        case "/api/mesh/enrollment-tokens":
        case "/api/collaboration/connections": case "/api/collaboration/guests":
        case "/api/collaboration/invitations": case "/api/collaboration/relays": return [];
        case "/api/workspaces": return [this.workspace];
        case "/api/execution-hosts": return [DEMO_HOST, DEMO_WORKER];
        case "/api/chats": return [...this.chats.values()];
        case "/api/terminal-sessions": return [this.terminal.session];
        case "/api/terminal-sessions/demo-terminal": return this.terminal.session;
        case "/api/automations": case "/api/control/requests": return [];
        case "/api/provisioning-jobs": case "/api/worker-update-jobs": return { jobs: [] };
        case "/api/models": this.requireWorkspace(url.searchParams.get("workspaceId")); return DEMO_MODELS;
        case "/api/git/branches": this.requireWorkspace(url.searchParams.get("workspaceId")); return { currentBranch: "main", branches: [{ name: "main", current: true }, { name: "demo/star-greeting", current: false }] };
        case "/api/git/default-branch": this.requireWorkspace(url.searchParams.get("workspaceId")); return { defaultBranch: "main" };
        case "/api/git/github-repository-url": this.requireWorkspace(url.searchParams.get("workspaceId")); return { githubUrl: null };
        case "/api/git/remote-status": this.requireWorkspace(url.searchParams.get("workspaceId")); return { remote: "origin", hasRemote: false };
        case "/api/trash": return { items: [], nextCursor: null };
      }
    }

    const preference = /^\/api\/preferences\/([^/]+)$/.exec(path)?.[1];
    if (preference && this.preferences.has(preference)) {
      if (method === "GET") return this.preferences.get(preference);
      if (method === "PUT") {
        let value: unknown;
        switch (preference) {
          case "theme": value = parse(z.object({ theme: z.enum(["dark", "light", "system"]) }).strict(), body); break;
          case "markdown-rendering": value = parse(SetMarkdownRenderingRequestSchema, body); break;
          case "file-explorer-full-tree": value = parse(SetFileExplorerFullTreeRequestSchema, body); break;
          case "quick-chat": {
            const settings = parse(SetQuickChatSettingsRequestSchema, body);
            this.requireWorkspace(settings.workspaceId);
            this.requireModel(settings.model);
            value = settings;
            break;
          }
          default: unsupported();
        }
        this.preferences.set(preference, value);
        return preference === "quick-chat" ? { success: true, settings: value } : value;
      }
    }

    if (method === "POST" && path === "/api/chats") {
      const input = parse(CreateChatRequestSchema, body);
      this.requireWorkspace(input.workspaceId);
      this.requireModel(input.model);
      if (input.directory && input.directory !== DEMO_DIRECTORY) unsupported();
      if (input.baseBranch && !["main", "demo/star-greeting"].includes(input.baseBranch)) {
        throw new DemoError(422, "demo_branch_unavailable", "Demo: choose one of the fictional branches shown in the selector.");
      }
      return this.createChat(input.name, undefined, input);
    }

    const hostRoute = /^\/api\/execution-hosts\/(local\/demo-host|mesh\/demo-worker)\/(.+)$/.exec(path);
    if (hostRoute) {
      const selectedHost = hostRoute[1] === "local/demo-host" ? DEMO_HOST : DEMO_WORKER;
      const host = hostRoute[2];
      if (method === "POST" && host === "working-directory") {
        parse(z.object({}).strict(), body);
        return { directory: DEMO_DIRECTORY, configured: true };
      }
      if (method === "POST" && host === "chat-providers") {
        parse(z.object({}).strict(), body);
        return { providers: [{ providerID: DEMO_MODEL.providerID, available: true }] };
      }
      if (method === "POST" && host === "chat-models") {
        const input = parse(DiscoverExecutionHostModelsRequestSchema, body);
        if (input.providerID !== DEMO_MODEL.providerID || input.directory !== DEMO_DIRECTORY) unsupported();
        return DEMO_MODELS;
      }
      if (method === "POST" && host === "chats") {
        const input = parse(CreateExecutionHostChatRequestSchema, body);
        this.requireModel(input.model);
        if (input.directory !== DEMO_DIRECTORY || input.adapter !== "copilot") unsupported();
        return this.createChat(input.name, selectedHost, { ...input, useWorktree: false });
      }
    }

    const workspace = /^\/api\/workspaces\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (workspace) {
      this.requireWorkspace(workspace[1] ?? null);
      if (method === "GET" && !workspace[2]) return this.workspace;
      if (method === "GET" && workspace[2] === "server-settings/status") {
        return { connected: true, provider: "copilot", adapter: "copilot", transport: "local", capabilities: [],
          directoryExists: true, isGitRepo: true, executionAvailability: "local" };
      }
    }

    const files = /^\/api\/(?:workspaces\/demo-workspace|execution-hosts\/(?:local\/demo-host|mesh\/demo-worker))\/files(?:\/(content|metadata|tree))?$/.exec(path);
    if (files && method === "GET") return this.files(url, files[1]);

    const chatRoute = /^\/api\/chats\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (chatRoute) {
      const chat = this.chats.get(chatRoute[1]!);
      if (!chat) throw new DemoError(404, "chat_not_found", "Demo: this fictional chat does not exist.");
      const action = chatRoute[2];
      if (method === "GET" && !action) return chat;
      if (method === "GET" && action === "snapshot") {
        return { config: chat.config, state: chat.state,
          transcript: demoTranscript(chat.config.id, chat.state.messages, chat.state.revision) } satisfies ChatSnapshot;
      }
      if (method === "GET" && action === "subagents") return { items: [] } satisfies SubagentList;
      if (method === "GET" && action === "activity") return {
        activity: { observation: "unavailable", reason: "unsupported" } satisfies HarnessActivitySnapshot,
      };
      if (method === "GET" && action === "diff") return DEMO_DIFF.map(({ patch: _patch, ...file }) => file);
      if (method === "GET" && action === "diff/file") {
        const input = parse(ChatDiffFileQuerySchema, Object.fromEntries(url.searchParams));
        const file = DEMO_DIFF.find((entry) => entry.path === input.path);
        if (input.base !== DEMO_DIFF_BASE || !file) {
          throw new DemoError(404, "chat_diff_file_not_found", "Demo: this file is not in the fictional change list.");
        }
        return file;
      }
      if (method === "GET" && action === "plan") return {
        exists: true,
        content: "# Demo plan\n\n- Add a friendly greeting.\n- Review the simulated diff.\n\nThis is fictional sample content; no execution takes place.",
      };
      if (method === "GET" && action === "status-file") return {
        exists: true, content: "# Demo status\n\nThe fictional greeting is ready to review.",
      };
      if (method === "GET" && action === "repository-context") return {
        isGitRepo: true, branch: "demo/star-greeting", pullRequest: null, pullRequestLookup: "none",
      };
      if (method === "POST" && action === "messages") {
        const input = parse(SendChatMessageRequestSchema, body);
        if (input.attachments.length) throw new DemoError(422, "demo_attachments_unavailable", "Demo: send text only. Attachments are not uploaded or processed.");
        if (chat.state.messages.length >= 100) throw new DemoError(409, "demo_message_limit", "Demo: this chat is full. Create another chat or reload to reset.");
        const timestamp = new Date().toISOString();
        chat.state.messages.push(
          { id: crypto.randomUUID(), role: "user", content: input.message ?? "", timestamp },
          { id: crypto.randomUUID(), role: "assistant", timestamp,
            content: "Demo simulated response: your message was received in this browser only. No AI model was called and no commands or file changes were made. Try opening Demo Observatory's Code Explorer or this chat's Diff view." },
        );
        chat.state.revision++;
        chat.state.lastUserMessageAt = timestamp;
        chat.state.lastActivityAt = timestamp;
        chat.config.updatedAt = timestamp;
        this.changed("chats", chat.config.id);
        return { success: true, chatId: chat.config.id, chat };
      }
    }

    unsupported();
  }

  private requireWorkspace(id: string | null): void {
    if (id !== this.workspace.id) throw new DemoError(404, "workspace_not_found", "Demo: choose Demo Observatory.");
  }

  private requireModel(model: { providerID: string; modelID: string; variant?: string } | null): void {
    if (!model || model.providerID !== DEMO_MODEL.providerID || model.modelID !== DEMO_MODEL.modelID || model.variant) {
      throw new DemoError(422, "demo_model_unavailable", "Demo: choose Demo simulated responses. Real providers and models are not connected.");
    }
  }

  private createChat(
    name?: string,
    host?: ExecutionHostDescriptor,
    input?: Pick<CreateChatRequest, "useWorktree" | "useSelectedBranchForWorktree" | "useChatNameAsBranch" | "startWithPlan" | "baseBranch">,
  ): Chat {
    if (this.chats.size >= 20) throw new DemoError(409, "demo_chat_limit", "Demo: reload to reset the 20-chat demo limit.");
    const chat = demoChat(crypto.randomUUID(), `Demo: ${name?.trim() || "new conversation"}`.slice(0, 100), new Date().toISOString(), host);
    if (input) {
      chat.config.useWorktree = input.useWorktree;
      chat.config.useSelectedBranchForWorktree = input.useSelectedBranchForWorktree;
      chat.config.useChatNameAsBranch = input.useChatNameAsBranch;
      chat.config.startWithPlan = input.startWithPlan;
      chat.config.baseBranch = input.baseBranch;
      if (input.useWorktree) chat.state.worktree = {
        originalBranch: input.baseBranch ?? "main",
        workingBranch: "demo/conversation",
        worktreePath: DEMO_DIRECTORY,
      };
    }
    this.chats.set(chat.config.id, chat);
    this.changed("chats", chat.config.id);
    return chat;
  }

  private files(url: URL, action?: string): unknown {
    const query = Object.fromEntries(url.searchParams);
    const input = action === "tree"
      ? { ...parse(GetFileExplorerTreeRequestSchema, query), path: "" }
      : action ? parse(GetFileExplorerFileRequestSchema, query) : parse(ListFileExplorerRequestSchema, query);
    const { path, startDirectory: start } = input;
    if (start && start !== DEMO_DIRECTORY) throw new DemoError(404, "directory_not_found", "Demo: only the fictional /demo/observatory directory is available.");
    const relative = path === DEMO_DIRECTORY ? "" : path.startsWith(`${DEMO_DIRECTORY}/`) ? path.slice(DEMO_DIRECTORY.length + 1) : path;
    const identity = url.pathname.startsWith("/api/workspaces/") ? { workspaceId: this.workspace.id }
      : { serverId: url.pathname.includes("/mesh/") ? "demo-worker" : "demo-host" };
    const entries = (directory: string): WorkspaceFileNode[] => Object.keys(DEMO_FILES)
      .filter(file => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "") === directory)
      .map(file => ({ name: file.slice(file.lastIndexOf("/") + 1), path: file, kind: "file" }));
    const root: WorkspaceFileNode[] = [...entries(""), { name: "src", path: "src", kind: "directory" }];
    if (action === "tree") return { ...identity, entriesByDirectory: { "": root, src: entries("src") } };
    if (!action) {
      if (relative !== "" && relative !== "src") throw new DemoError(404, "directory_not_found", "Demo: this fictional directory does not exist.");
      return { ...identity, directory: relative, entries: relative ? entries(relative) : root };
    }
    const content = DEMO_FILES[relative];
    if (content === undefined) throw new DemoError(404, "file_not_found", "Demo: this fictional file does not exist.");
    const file: WorkspaceFileEntry = {
      name: relative.slice(relative.lastIndexOf("/") + 1), path: relative, kind: "file",
      absolutePath: `${DEMO_DIRECTORY}/${relative}`, size: new TextEncoder().encode(content).length,
      modifiedAt: this.now, versionToken: "demo:1", mimeType: "text/plain", isImage: false, isVideo: false,
    };
    return { ...identity, file, ...(action === "metadata" ? {} : { content }) };
  }

  async resourceUrl(path: string, options: { signal?: AbortSignal; kind?: "resource" | "websocket" }): Promise<WebAppResourceUrl> {
    if (options.kind === "websocket") unsupported();
    const response = await this.request(new Request(new URL(path, `${DEMO_CONTROLLER_ENDPOINT}/`), { signal: options.signal }));
    if (!response.ok) {
      const failure: unknown = await response.json();
      throw new Error(parse(z.object({ message: z.string() }), failure).message);
    }
    const { content } = parse(z.object({ content: z.string() }), await response.json());
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    this.urls.add(url);
    return { url, expiresAt: null, dispose: () => { URL.revokeObjectURL(url); this.urls.delete(url); } };
  }

  async connect(path: string, options: { signal?: AbortSignal }): Promise<WebAppDuplex> {
    options.signal?.throwIfAborted();
    const url = new URL(path, DEMO_CONTROLLER_ENDPOINT);
    if (this.disposed || url.origin !== DEMO_CONTROLLER_ENDPOINT) unsupported();
    if (url.pathname === "/api/terminal" && url.searchParams.get("terminalSessionId") === this.terminal.session.config.id) {
      return this.terminal.connect(options);
    }
    if (url.pathname !== "/api/realtime") unsupported();
    const handlers = new Set<WebAppDuplexHandlers>();
    const subscriptions = new Map<string, { generation: number; interest: RealtimeInterest }>();
    let closed = false;
    const message = (value: RealtimeServerMessage) => {
      const data = JSON.stringify(value);
      queueMicrotask(() => { if (!closed) for (const handler of handlers) handler.onMessage(data); });
    };
    const close = async (code = 1000, reason = "Demo connection closed") => {
      if (closed) return;
      closed = true;
      this.connections.delete(connection);
      subscriptions.clear();
      options.signal?.removeEventListener("abort", aborted);
      for (const handler of handlers) handler.onClose({ code, reason });
      handlers.clear();
    };
    const aborted = () => { void close(); };
    const connection = {
      close,
      publish: (event: ResourceRealtimeEvent) => {
        const selected = [...subscriptions].filter(([, value]) => realtimeInterestMatches(value.interest, "state", event, { resource: event.resource, id: event.id }))
          .map(([subscriptionId, value]) => ({ subscriptionId, generation: value.generation }));
        if (selected.length) message({ type: "event", subscriptions: selected, event });
      },
    };
    this.connections.add(connection);
    options.signal?.addEventListener("abort", aborted, { once: true });
    return {
      ready: Promise.resolve(), bufferedAmount: 0,
      subscribe: listener => { handlers.add(listener); return () => { handlers.delete(listener); }; },
      send: async data => {
        if (closed) throw new Error("Demo connection is closed.");
        if (typeof data !== "string" || data.length > 64_000) throw new Error("Demo realtime expects a bounded JSON text frame.");
        const input = parse(realtimeClientMessageSchema, JSON.parse(data));
        if (input.type === "ping") message({ type: "pong" });
        else if (input.type === "subscribe") {
          if (subscriptions.size >= 128 && !subscriptions.has(input.subscriptionId)) throw new Error("Demo subscription limit reached.");
          subscriptions.set(input.subscriptionId, { generation: input.generation, interest: input.interest });
          message({ type: "subscribed", subscriptionId: input.subscriptionId, generation: input.generation });
        } else {
          subscriptions.delete(input.subscriptionId);
          message({ type: "unsubscribed", subscriptionId: input.subscriptionId, generation: input.generation });
        }
      },
      close,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.terminal.dispose();
    for (const connection of this.connections) void connection.close();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.chats.clear();
    this.preferences.clear();
  }
}

let controller: DemoController | undefined;
export function getDemoController(): DemoController | undefined { return controller; }
export function startDemoController(): void {
  controller?.dispose();
  controller = new DemoController();
}
export function stopDemoController(): void {
  controller?.dispose();
  controller = undefined;
}
