/**
 * External GPT-Live network peer: targets and technical settings come from
 * production tool results, never injected application objects or identifiers.
 */

export const GLOBAL_LIVE_INTENT = {
  workspaceA: "Live workspace A",
  workspaceB: "Live workspace B",
  sourceChat: "Live source conversation",
  sourceTask: "Live source task",
  createdTask: "Live delegated task",
  createdChat: "Live delegated conversation",
  hostFile: "voice-handoff.txt",
};

interface FixtureTool { name: string; arguments: Record<string, unknown> }
type FixtureStep = FixtureTool | { wait: "confirmation" } | { wait: "work"; chatId: string };
interface OperationDescription { operationId: string; parameters: string[] }
interface OperationPage { operations: Array<{ operationId: string }>; nextCursor: number | null }
interface Workspace { id: string; name: string }
interface Host { ref: { kind: string; serverId?: string } }
interface Server { config: { id: string; repositoriesBasePath: string } }
interface Chat { config: { id: string; name: string }; state: { status: string } }
interface Task { config: { id: string; name: string; prompt: string }; state: { status: string } }
interface Snapshot { transcript: { messages: Array<{ role: string; content: string }> } }
interface CreationContext {
  ready: boolean;
  defaults: Record<string, unknown> & {
    model: { providerID: string; modelID: string; variant?: string } | null;
    cheapModel: Record<string, unknown> | null;
    baseBranch: string | null;
  };
  models: { available: Array<{ providerID: string; modelID: string; connected: boolean }> };
}

export interface LiveFixture {
  id: string;
  global: boolean;
  stage: number;
  started: boolean;
  current?: FixtureStep;
  journey?: Generator<FixtureStep, void, unknown>;
  result?: unknown;
  notices: Array<{ kind: "confirmation" | "work"; content: string; result: unknown }>;
  diagnostic?: string;
  socket?: Bun.ServerWebSocket<LiveFixture>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected a public tool object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function successful<T>(value: unknown): T {
  const result = record(value);
  if (result["ok"] === false) throw new Error(`Global Live operation failed: ${JSON.stringify(result)}`);
  return (result["data"] ?? result) as T;
}

function* globalJourney(): Generator<FixtureStep, void, unknown> {
  const descriptions = new Map<string, OperationDescription>();
  function* operation<T>(id: string, options: {
    parameters?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    confirmationDescription?: string;
  } = {}): Generator<FixtureStep, T, unknown> {
    let description = descriptions.get(id);
    if (!description) {
      const [method, path] = id.split(" ");
      let cursor: number | null = null;
      let found: string | undefined;
      do {
        const page = (yield {
          name: "clanky_find_operations",
          arguments: { text: path, method, domain: null, cursor },
        }) as OperationPage;
        found = page.operations.find((entry) => entry.operationId === id)?.operationId;
        cursor = page.nextCursor;
      } while (!found && cursor !== null);
      if (!found) throw new Error(`Required product operation is unavailable: ${id}`);
      description = (yield {
        name: "clanky_describe_operation", arguments: { operationId: found },
      }) as OperationDescription;
      descriptions.set(id, description);
    }
    let result = record(yield {
      name: "clanky_execute_operation",
      arguments: {
        operationId: description.operationId,
        parameters: description.parameters.map((name) => ({ name, value: options.parameters?.[name] })),
        query: Object.entries(options.query ?? {}).map(([name, value]) => ({ name, value })),
        bodyJson: options.body === undefined ? null : JSON.stringify(options.body),
        confirmationDescription: options.confirmationDescription ?? null,
      },
    });
    if (result["code"] === "confirmation_required") result = record(yield { wait: "confirmation" });
    return successful<T>(result);
  }

  const context = record(yield { name: "clanky_get_ui_state", arguments: {} });
  const planning = record(record(context["context"])["planningPreferences"]);
  const workspaces = yield* operation<Workspace[]>("GET /api/workspaces");
  const workspaceA = workspaces.find((workspace) => workspace.name === GLOBAL_LIVE_INTENT.workspaceA)!;
  const workspaceB = workspaces.find((workspace) => workspace.name === GLOBAL_LIVE_INTENT.workspaceB)!;
  if (!workspaceA || !workspaceB) throw new Error("The requested workspaces are unavailable.");
  const hosts = yield* operation<Host[]>("GET /api/execution-hosts");
  const ssh = hosts.find((host) => host.ref.kind === "ssh");
  if (!hosts.some((host) => host.ref.kind === "local") || !ssh?.ref.serverId) {
    throw new Error("The caller's local and SSH execution hosts are unavailable.");
  }
  const servers = yield* operation<Server[]>("GET /api/ssh-servers");
  const server = servers.find((entry) => entry.config.id === ssh.ref.serverId)!;
  const hostFile = yield* operation<{ content: string }>("GET /api/execution-hosts/:kind/:id/files/content", {
    parameters: { kind: ssh.ref.kind, id: server.config.id },
    query: { path: GLOBAL_LIVE_INTENT.hostFile, startDirectory: server.config.repositoriesBasePath },
  });
  const chats = yield* operation<Chat[]>("GET /api/chats", { query: { workspaceId: workspaceA.id } });
  const sourceChat = chats.find((chat) => chat.config.name === GLOBAL_LIVE_INTENT.sourceChat)!;
  const chat = yield* operation<Chat>("GET /api/chats/:id", { parameters: { id: sourceChat.config.id } });
  const snapshot = yield* operation<Snapshot>("GET /api/chats/:id/snapshot", { parameters: { id: chat.config.id } });
  const answer = snapshot.transcript.messages.findLast((message) => message.role === "assistant" && message.content.trim())!;
  const tasks = yield* operation<Task[]>("GET /api/tasks");
  const sourceTask = tasks.find((task) => task.config.name === GLOBAL_LIVE_INTENT.sourceTask)!;
  const task = yield* operation<Task>("GET /api/tasks/:id", { parameters: { id: sourceTask.config.id } });
  const creation = yield* operation<CreationContext>("GET /api/workspaces/:id/task-creation-context", {
    parameters: { id: workspaceB.id },
  });
  const model = creation.defaults.model ?? creation.models.available.find((entry) => entry.connected);
  if (!creation.ready || !model || !creation.defaults.baseBranch || !answer) {
    throw new Error("The selected workspace is not ready for the requested work.");
  }
  const selectedModel = { providerID: model.providerID, modelID: model.modelID, variant: "variant" in model ? model.variant : "" };
  const handoff = `${task.config.prompt}\nTask status: ${task.state.status}; chat status: ${chat.state.status}.\nLatest answer: ${answer.content}\nSSH handoff: ${hostFile.content}`;

  // The user declines retirement of A, then explicitly approves new work on B.
  yield* operation("DELETE /api/tasks/:id", {
    parameters: { id: task.config.id },
    confirmationDescription: `Delete the saved task "${task.config.name}" in "${workspaceA.name}". This permanently removes its task data.`,
  });
  yield* operation("GET /api/tasks/:id", { parameters: { id: task.config.id } });
  yield* operation("POST /api/tasks", {
    confirmationDescription: `Create the draft task "${GLOBAL_LIVE_INTENT.createdTask}" in "${workspaceB.name}" from the source conversation and host guidance. It will wait for your approval before running or accepting its plan.`,
    body: {
      ...creation.defaults,
      ...planning,
      name: GLOBAL_LIVE_INTENT.createdTask, workspaceId: workspaceB.id, prompt: handoff,
      model: selectedModel, cheapModel: creation.defaults.cheapModel, draft: true,
    },
  });
  const createdTask = (yield* operation<Task[]>("GET /api/tasks"))
    .find((entry) => entry.config.name === GLOBAL_LIVE_INTENT.createdTask)!;
  successful(yield {
    name: "clanky_ui_action", arguments: { action: { type: "open_task", taskId: createdTask.config.id } },
  });
  yield* operation("POST /api/chats", {
    confirmationDescription: `Create the chat "${GLOBAL_LIVE_INTENT.createdChat}" in "${workspaceB.name}" with the saved model and branch choices. Permission requests will require your approval.`,
    body: {
      name: GLOBAL_LIVE_INTENT.createdChat, workspaceId: workspaceB.id,
      model: selectedModel, baseBranch: creation.defaults.baseBranch,
      useWorktree: false, autoApprovePermissions: false,
    },
  });
  const createdChat = (yield* operation<Chat[]>("GET /api/chats", { query: { workspaceId: workspaceB.id } }))
    .find((entry) => entry.config.name === GLOBAL_LIVE_INTENT.createdChat)!;
  successful(yield {
    name: "clanky_watch_work",
    arguments: { command: "add", targets: [
      { kind: "task", id: createdTask.config.id }, { kind: "chat", id: createdChat.config.id },
    ] },
  });
  yield* operation("POST /api/chats/:id/messages", {
    parameters: { id: createdChat.config.id },
    body: { message: `${handoff}\n[question] [provider-write] Ask before continuing the delegated work.`, attachments: [] },
  });
  yield { wait: "work", chatId: createdChat.config.id };
  yield* operation("GET /api/chats/:id", { parameters: { id: createdChat.config.id } });
  const watched = successful<{ watching: Array<{ kind: string; id: string }> }>(
    yield { name: "clanky_watch_work", arguments: { command: "list", targets: [] } },
  );
  const followed = watched.watching.find((target) => target.kind === "chat")!;
  successful(yield {
    name: "clanky_ui_action", arguments: { action: { type: "open_chat", chatId: followed.id } },
  });
  successful(yield { name: "clanky_get_ui_state", arguments: {} });
}

function send(session: LiveFixture, event: Record<string, unknown>): void {
  session.socket?.send(JSON.stringify(event));
}

function responseEvent(session: LiveFixture, event: Record<string, unknown>): void {
  send(session, { type: "response.event", delegation_id: `${session.id}-${session.stage}`, event });
}

function advance(session: LiveFixture, result?: unknown): void {
  try {
    const next = session.journey!.next(result);
    session.current = next.done ? undefined : next.value;
    if (!session.current) return;
    if ("wait" in session.current) {
      const wait = session.current;
      const index = session.notices.findIndex((notice) => notice.kind === wait.wait
        && (wait.wait !== "work" || notice.content.includes(`chat ${wait.chatId} `)
          && notice.content.includes('"status":"waiting"')));
      if (index >= 0) advance(session, session.notices.splice(index, 1)[0]!.result);
      return;
    }
    session.stage++;
    const id = `${session.id}-${session.stage}`;
    send(session, {
      type: "session.delegation.created",
      delegation: { id, target: "responses", response_id: id },
    });
    responseEvent(session, { type: "response.created", response: { id } });
    responseEvent(session, {
      type: "response.output_item.done",
      item: { type: "function_call", call_id: `${id}-tool`, name: session.current.name, arguments: JSON.stringify(session.current.arguments) },
    });
    responseEvent(session, { type: "response.completed", response: { id, output: [] } });
  } catch (error) {
    session.diagnostic = String(error);
    send(session, { type: "error", code: "fixture_product_journey_failed" });
  }
}

export const liveFixtureWebSocket = {
  open(socket: Bun.ServerWebSocket<LiveFixture>) {
    socket.data.socket = socket;
    send(socket.data, { type: "session.started" });
  },
  message(socket: Bun.ServerWebSocket<LiveFixture>, raw: string | Buffer) {
    const event = record(JSON.parse(String(raw)));
    const session = socket.data;
    if (event["type"] === "session.close") {
      send(session, { type: "session.closed" });
      socket.close();
      return;
    }
    if (!session.global) return;
    if (event["type"] === "session.thinking.append") {
      const content = String(event["content"]);
      const prefix = "Visual confirmation result (authoritative data): ";
      if (content.startsWith(prefix)) {
        // Commentary is bounded prose. Reread created work through real tools
        // instead of treating a possibly truncated commentary fragment as JSON.
        session.notices.push({ kind: "confirmation", content, result: { ok: true, code: "confirmation_resolved" } });
      } else if (content.startsWith("The user rejected")) {
        session.notices.push({ kind: "confirmation", content, result: { ok: true, code: "confirmation_rejected" } });
      } else if (content.startsWith("Authoritative watched")) {
        session.notices.push({ kind: "work", content, result: {} });
      }
      session.notices = session.notices.slice(-16);
      if (!session.started) {
        session.started = true;
        session.journey = globalJourney();
        advance(session);
      } else if (session.current && "wait" in session.current) {
        const wait = session.current;
        const index = session.notices.findIndex((notice) => notice.kind === wait.wait
          && (wait.wait !== "work" || notice.content.includes(`chat ${wait.chatId} `)
            && notice.content.includes('"status":"waiting"')));
        if (index >= 0) advance(session, session.notices.splice(index, 1)[0]!.result);
      }
    }
    if (event["type"] === "response.item.create") {
      session.result = JSON.parse(String(record(event["item"])["output"]));
    }
    if (event["type"] === "response.create") {
      const id = `${session.id}-continuation-${session.stage}`;
      responseEvent(session, { type: "response.in_progress", response: { id } });
      responseEvent(session, { type: "response.completed", response: { id, output: [] } });
      advance(session, session.result);
      session.result = undefined;
    }
  },
};
