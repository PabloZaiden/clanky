/**
 * External GPT-Live network peer: targets and technical settings come from
 * production tool results, never injected application objects or identifiers.
 */

export const GLOBAL_LIVE_INTENT = {
  workspaceA: "Live workspace A",
  workspaceB: "Live workspace B",
  sourceChat: "Live source conversation",
  streamingChat: "Live streaming conversation",
  steeringWorkspace: "Live steering workspace",
  steeringChat: "Live queued-message steering chat",
  steeringMessage: "Live steering request [voice-end-wait]: finish this accepted instruction after Voice ends.",
  doneChat: "Live completed conversation",
  errorChat: "Live failed conversation",
  sourceTask: "Live source task",
  completedTask: "Live completed status task",
  failedTask: "Live failed status task",
  createdTask: "Live delegated task",
  createdChat: "Live delegated conversation",
  hostFile: "voice-handoff.txt",
};

interface FixtureTool { name: string; arguments: Record<string, unknown> }
type FixtureStep = FixtureTool | { wait: "confirmation" } | { wait: "work"; chatId: string };
interface OperationDescription { operationId: string; parameters: string[] }
interface OperationIndex {
  columns: string[];
  operations: Array<[string, string, string]>;
  total: number;
}
interface Workspace { id: string; name: string; directory: string }
interface Host { ref: { kind: string; nodeId: string } }
interface VoiceStatusWork { id: string; name: string; status: string; voiceStatus: string }
type Chat = VoiceStatusWork;
type Task = VoiceStatusWork;
interface ConversationMessage { id: string; role: string; content: string; offset: number }
interface ContentPart { path: Array<string | number>; value: unknown; offset: number; complete: boolean }

export interface LiveFixture {
  id: string;
  global: boolean;
  resume?: boolean;
  history?: Array<{ role: string; content: Array<{ text: string }> }>;
  connectedAt?: number;
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

function assertVoiceStatus(
  work: VoiceStatusWork | undefined,
  status: string,
  voiceStatus: string,
): asserts work is VoiceStatusWork {
  if (!work) throw new Error("The requested work item is unavailable.");
  if (work.status !== status || work.voiceStatus !== voiceStatus) {
    throw new Error(
      `Expected ${work.name} to have status ${status} and voiceStatus ${voiceStatus}; received ${work.status}/${work.voiceStatus}.`,
    );
  }
}

function restoreContent(parts: ContentPart[]): unknown {
  let root: unknown;
  for (const part of parts) {
    if (!part.path.length) {
      root = typeof part.value === "string" && part.offset ? String(root) + part.value : part.value;
      continue;
    }
    root ??= typeof part.path[0] === "number" ? [] : Object.create(null);
    let parent = root as Record<string, unknown>;
    for (const [index, key] of part.path.entries()) {
      if (index === part.path.length - 1) {
        Object.defineProperty(parent, key, { configurable: true, enumerable: true, writable: true,
          value: typeof part.value === "string" && part.offset ? String(parent[key]) + part.value : part.value });
      } else {
        if (!Object.hasOwn(parent, key)) Object.defineProperty(parent, key, {
          configurable: true, enumerable: true, writable: true,
          value: typeof part.path[index + 1] === "number" ? [] : Object.create(null),
        });
        parent = parent[key] as Record<string, unknown>;
      }
    }
  }
  return root;
}

function operationTools() {
  const descriptions = new Map<string, OperationDescription>();
  let index: OperationIndex | undefined;
  return function* operation<T>(id: string, options: {
    parameters?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    confirmationDescription?: string;
  } = {}): Generator<FixtureStep, T, unknown> {
    let description = descriptions.get(id);
    if (!description) {
      index ??= (yield { name: "clanky_list_operations", arguments: {} }) as OperationIndex;
      if (JSON.stringify(index.columns) !== JSON.stringify(["operationId", "policy", "description"])
        || index.total !== index.operations.length) throw new Error("The complete operation index was not delivered.");
      const found = index.operations.find(([operationId]) => operationId === id)?.[0];
      if (!found) throw new Error(`Required product operation is unavailable: ${id}`);
      description = (yield {
        name: "clanky_describe_operation", arguments: { operationId: found, section: null, cursor: null },
      }) as OperationDescription;
      descriptions.set(id, description);
    }
    let cursor: string | null = null;
    const items: unknown[] = [];
    do {
      let result = record(yield {
        name: "clanky_execute_operation",
        arguments: {
          operationId: description.operationId,
          parameters: description.parameters.map((name) => ({ name, value: options.parameters?.[name] })),
          query: Object.entries({ ...options.query, ...(cursor ? { cursor } : {}) }).map(([name, value]) => ({ name, value })),
          bodyJson: options.body === undefined ? null : JSON.stringify(options.body),
          confirmationDescription: options.confirmationDescription ?? null,
        },
      });
      if (result["code"] === "confirmation_required") result = record(yield { wait: "confirmation" });
      const data = successful<unknown>(result);
      if (!data || typeof data !== "object" || !("items" in data) || !Array.isArray(data.items)) return data as T;
      items.push(...data.items);
      if (!("nextCursor" in data) || data.nextCursor !== null && typeof data.nextCursor !== "string") {
        throw new Error("The public read page has no continuation contract.");
      }
      cursor = data.nextCursor;
    } while (cursor !== null);
    if (items.length && Array.isArray(record(items[0])["path"])) return restoreContent(items as ContentPart[]) as T;
    return items as T;
  };
}

function* direct<T>(name: string, args: Record<string, unknown>): Generator<FixtureStep, T, unknown> {
  let result = record(yield { name, arguments: args });
  if (result["code"] === "confirmation_required") result = record(yield { wait: "confirmation" });
  return successful<T>(result);
}

function* directCollection<T>(name: string, args: Record<string, unknown> = {}): Generator<FixtureStep, T[], unknown> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor: string | null } = yield* direct(name, { ...args, cursor });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
}

function* directContent(name: string, args: Record<string, unknown>): Generator<FixtureStep, {
  target: Chat | Task; interactions: Array<{ kind: string; requestId: string; status: string }>; content: unknown;
}, unknown> {
  let cursor: string | null = null;
  let result: { target: Chat | Task; interactions: Array<{ kind: string; requestId: string; status: string }>; content: unknown } | undefined;
  const items: unknown[] = [];
  do {
    const page: NonNullable<typeof result> = yield* direct(name, { ...args, cursor });
    result = page;
    const content = record(page.content);
    if (!Array.isArray(content["items"])) throw new Error("The selected work content is unavailable.");
    items.push(...content["items"]);
    cursor = typeof content["nextCursor"] === "string" ? content["nextCursor"] : null;
  } while (cursor !== null);
  return {
    ...result!,
    content: items.length && Array.isArray(record(items[0])["path"]) ? restoreContent(items as ContentPart[]) : items,
  };
}

function* globalJourney(): Generator<FixtureStep, void, unknown> {
  const operation = operationTools();
  const health = yield* operation<{ ok: boolean; version: string }>("GET /api/health");
  if (!health.ok || !health.version) throw new Error("The running instance health and version are unavailable.");
  yield { name: "clanky_get_ui_state", arguments: { section: null, cursor: null } };
  const workspaces = yield* directCollection<Workspace>("clanky_list_workspaces", { limit: null });
  const workspaceA = workspaces.find((workspace) => workspace.name === GLOBAL_LIVE_INTENT.workspaceA)!;
  const workspaceB = workspaces.find((workspace) => workspace.name === GLOBAL_LIVE_INTENT.workspaceB)!;
  if (!workspaceA || !workspaceB) throw new Error("The requested workspaces are unavailable.");
  const hosts = yield* directCollection<Host>("clanky_list_servers", { limit: null });
  const local = hosts.find((host) => host.ref.kind === "local");
  if (!local) throw new Error("The caller's local execution host is unavailable.");
  const hostFile = yield* operation<{ content: string }>("GET /api/execution-hosts/:kind/:id/files/content", {
    parameters: { kind: local.ref.kind, id: local.ref.nodeId },
    query: { path: GLOBAL_LIVE_INTENT.hostFile, startDirectory: workspaceB.directory },
  });
  const listedChats = yield* directCollection<Chat>("clanky_list_chats", {
    name: null, workspace: workspaceA.name, status: null, limit: 20,
  });
  assertVoiceStatus(listedChats.find((chat) => chat.name === GLOBAL_LIVE_INTENT.streamingChat), "streaming", "active");
  assertVoiceStatus(listedChats.find((chat) => chat.name === GLOBAL_LIVE_INTENT.sourceChat), "idle", "idle");
  assertVoiceStatus(listedChats.find((chat) => chat.name === GLOBAL_LIVE_INTENT.doneChat), "done", "done");
  assertVoiceStatus(listedChats.find((chat) => chat.name === GLOBAL_LIVE_INTENT.errorChat), "failed", "error");
  const steered = yield* direct<{
    chatId: string; messageId: string; admission: { status: string; inputId: string };
  }>("clanky_steer_queued_chat_message", {
    target: GLOBAL_LIVE_INTENT.steeringChat, workspace: GLOBAL_LIVE_INTENT.steeringWorkspace, messageId: null,
  });
  if (steered.admission.status !== "accepted" || steered.messageId !== steered.admission.inputId) {
    throw new Error(`The queued chat message was not admitted for native steering: ${JSON.stringify(steered)}`);
  }

  const recent = yield* direct<{ entries: Array<Chat & { kind: string }> }>("clanky_recent_work", {
    kind: "chat", workspace: workspaceA.name, status: null, cursor: null, limit: 20,
  });
  const sourceChat = recent.entries.find((chat) => chat.name === GLOBAL_LIVE_INTENT.sourceChat);
  assertVoiceStatus(sourceChat, "idle", "idle");
  assertVoiceStatus(recent.entries.find((chat) => chat.name === GLOBAL_LIVE_INTENT.streamingChat), "streaming", "active");
  assertVoiceStatus(recent.entries.find((chat) => chat.name === GLOBAL_LIVE_INTENT.doneChat), "done", "done");
  assertVoiceStatus(recent.entries.find((chat) => chat.name === GLOBAL_LIVE_INTENT.errorChat), "failed", "error");
  const read = yield* directContent("clanky_read_chat", {
    target: sourceChat.name, workspace: workspaceA.name, range: "latest", limit: 6,
  });
  const chat = read.target as Chat;
  assertVoiceStatus(chat, "idle", "idle");
  const conversation = read.content as ConversationMessage[];
  const answerParts = conversation.filter((message) => message.id === conversation.findLast((entry) => entry.role === "assistant" && entry.content.trim())?.id);
  const answer = answerParts.map((part) => part.content).join("");
  yield* direct("clanky_update_chat_lifecycle", {
    target: sourceChat.name,
    workspace: workspaceA.name,
    action: "mark_done",
    confirmationDescription: null,
  });
  const waiting = yield* direct<{ entries: Array<Task & { kind: string; interventionReasons: string[] }> }>("clanky_waiting_work", {
    kind: "task", workspace: workspaceA.name, cursor: null, limit: 3,
  });
  const sourceTask = waiting.entries.find((task) => task.name === GLOBAL_LIVE_INTENT.sourceTask && task.interventionReasons.includes("plan_approval"));
  assertVoiceStatus(sourceTask, "planning", "active");
  const taskRead = yield* directContent("clanky_read_task", {
    target: sourceTask.name, workspace: workspaceA.name, section: "prompt", range: "latest", limit: null,
  });
  const task = taskRead.target as Task;
  assertVoiceStatus(task, "planning", "active");
  const listedTasks = yield* directCollection<Task>("clanky_list_tasks", {
    name: null, workspace: workspaceA.name, status: null, limit: 20,
  });
  assertVoiceStatus(listedTasks.find((entry) => entry.name === GLOBAL_LIVE_INTENT.sourceTask), "planning", "active");
  assertVoiceStatus(listedTasks.find((entry) => entry.name === GLOBAL_LIVE_INTENT.completedTask), "completed", "done");
  assertVoiceStatus(listedTasks.find((entry) => entry.name === GLOBAL_LIVE_INTENT.failedTask), "failed", "error");
  const recentTasks = yield* direct<{ entries: Array<Task & { kind: string }> }>("clanky_recent_work", {
    kind: "task", workspace: workspaceA.name, status: null, cursor: null, limit: 20,
  });
  assertVoiceStatus(recentTasks.entries.find((entry) => entry.name === GLOBAL_LIVE_INTENT.completedTask), "completed", "done");
  assertVoiceStatus(recentTasks.entries.find((entry) => entry.name === GLOBAL_LIVE_INTENT.failedTask), "failed", "error");
  const prompt = taskRead.content;
  if (typeof prompt !== "string" || !answer) throw new Error("The requested source work is unreadable.");
  const handoff = `${prompt}\nTask status: ${task.status}; chat status: ${chat.status}.\nLatest answer: ${answer}\nHost handoff: ${hostFile.content}`;

  // The user declines retirement of A, then explicitly approves new work on B.
  yield* operation("DELETE /api/tasks/:id", {
    parameters: { id: task.id },
    confirmationDescription: `Delete the saved task "${task.name}" in "${workspaceA.name}". This permanently removes its task data.`,
  });
  yield* direct("clanky_read_task", {
    target: task.id, workspace: workspaceA.name, section: "plan", range: "latest", cursor: null, limit: null,
  });
  yield* direct("clanky_create_task", {
    confirmationDescription: `Create the draft task "${GLOBAL_LIVE_INTENT.createdTask}" in "${workspaceB.name}" from the source conversation and host guidance. It will wait for your approval before running or accepting its plan.`,
    name: GLOBAL_LIVE_INTENT.createdTask, workspace: workspaceB.name, prompt: handoff,
    model: null, cheapModel: null, draft: true, baseBranch: null, useWorktree: null, autoAcceptPlan: null, fullyAutonomous: null,
  });
  const createdTask = (yield* directCollection<Task>("clanky_list_tasks", {
    name: GLOBAL_LIVE_INTENT.createdTask, workspace: workspaceB.name, status: null, limit: null,
  }))[0]!;
  assertVoiceStatus(createdTask, "draft", "idle");
  successful(yield {
    name: "clanky_ui_action", arguments: { action: { type: "open_named", kind: "task", target: createdTask.name, workspace: workspaceB.name } },
  });
  yield* direct("clanky_create_chat", {
    confirmationDescription: `Create the chat "${GLOBAL_LIVE_INTENT.createdChat}" in "${workspaceB.name}" with the saved model and branch choices. Permission requests are automatically approved.`,
    name: GLOBAL_LIVE_INTENT.createdChat, workspace: workspaceB.name, host: null, directory: null,
    model: null, baseBranch: null, useWorktree: false, initialMessage: null, open: false, afterCreationDescription: null,
  });
  const createdChat = (yield* directCollection<Chat>("clanky_list_chats", {
    name: GLOBAL_LIVE_INTENT.createdChat, workspace: workspaceB.name, status: null, limit: null,
  }))[0]!;
  assertVoiceStatus(createdChat, "idle", "idle");
  successful(yield {
    name: "clanky_watch_work",
    arguments: { command: "add", targets: [
      { kind: "task", id: createdTask.id }, { kind: "chat", id: createdChat.id },
    ] },
  });
  yield* direct("clanky_send_chat_message", {
    target: createdChat.name, workspace: workspaceB.name,
    message: `${handoff}\n[question] [provider-write] Ask before continuing the delegated work.`,
  });
  yield { wait: "work", chatId: createdChat.id };
  const attention = yield* direct<{ entries: Array<Chat & { preview: { interactions?: unknown[] } }> }>("clanky_waiting_work", {
    kind: "all", workspace: null, cursor: null, limit: 3,
  });
  const needsAnswer = attention.entries.find((entry) => entry.id === createdChat.id);
  assertVoiceStatus(needsAnswer, "waiting", "active");
  if (!needsAnswer?.preview.interactions?.length) throw new Error("The delegated work's pending question is unavailable.");
  const waitingChats = yield* directCollection<Chat>("clanky_list_chats", {
    name: GLOBAL_LIVE_INTENT.createdChat, workspace: workspaceB.name, status: null, limit: null,
  });
  assertVoiceStatus(waitingChats[0], "waiting", "active");
  const watched = successful<{ watching: Array<{ kind: string; id: string }> }>(
    yield { name: "clanky_watch_work", arguments: { command: "list", targets: [] } },
  );
  const followed = watched.watching.find((target) => target.kind === "chat")!;
  successful(yield {
    name: "clanky_ui_action", arguments: { action: { type: "open_chat", chatId: followed.id } },
  });
  successful(yield { name: "clanky_get_ui_state", arguments: {} });
  yield* direct("clanky_update_chat_lifecycle", {
    target: GLOBAL_LIVE_INTENT.errorChat,
    workspace: GLOBAL_LIVE_INTENT.workspaceA,
    action: "move_to_trash",
    confirmationDescription: `Move "${GLOBAL_LIVE_INTENT.errorChat}" to Trash for 30 days. Its active work will stop; its conversation and worktree remain recoverable.`,
  });
}

function rememberedReference(session: LiveFixture, name: string): string {
  let id: string | undefined;
  for (const message of session.history ?? []) {
    for (const part of message.content) {
      const start = part.text.indexOf("{");
      if (start < 0) continue;
      let data: unknown;
      try { data = JSON.parse(part.text.slice(start)); }
      catch {
        // Spoken prose and bounded historical excerpts need not be JSON.
        continue;
      }
      const refs = record(data)["references"];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        const entity = record(ref);
        if (entity["name"] === name && typeof entity["id"] === "string") id = entity["id"];
      }
    }
  }
  if (!id) throw new Error(`The previous voice context does not identify "${name}".`);
  return id;
}

function* resumedJourney(session: LiveFixture): Generator<FixtureStep, void, unknown> {
  const id = rememberedReference(session, GLOBAL_LIVE_INTENT.createdChat);
  const read = yield* directContent("clanky_read_chat", {
    target: id, workspace: null, range: "latest", limit: 6,
  });
  const chat = read.target as Chat;
  assertVoiceStatus(chat, "waiting", "active");
  const question = read.interactions.find((entry) => entry.kind === "question" && entry.status === "pending");
  if (!question) throw new Error("The previously delegated conversation has no pending question.");
  yield* direct("clanky_respond_chat_interaction", {
    target: chat.name, workspace: GLOBAL_LIVE_INTENT.workspaceB, kind: "question", requestId: question.requestId,
    answers: [["Concise"]], decision: null, confirmationDescription: null,
  });
  successful(yield {
    name: "clanky_ui_action", arguments: { action: { type: "open_chat", chatId: chat.id } },
  });
  yield { name: "clanky_accept_goodbye", arguments: {} };
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
    if (!session.current) {
      send(session, {
        type: "session.output_transcript.delta", event_id: crypto.randomUUID(),
        delta: session.resume ? "I answered the question in the conversation we created."
          : `The chat "${GLOBAL_LIVE_INTENT.createdChat}" is waiting for your answer. We can continue later.`,
        start_ms: Date.now() - session.connectedAt!, end_ms: Date.now() - session.connectedAt! + 1,
      });
      return;
    }
    if ("wait" in session.current) {
      const wait = session.current;
      const index = session.notices.findIndex((notice) => notice.kind === wait.wait
        && (wait.wait !== "work" || notice.content.includes(`chat ${wait.chatId} `)
          && notice.content.includes('"status":"waiting"')));
      if (index >= 0) advance(session, session.notices.splice(index, 1)[0]!.result);
      return;
    }
    if ("name" in session.current && session.current.name === "clanky_accept_goodbye") {
      const start = Date.now() - session.connectedAt!;
      send(session, {
        type: "session.output_transcript.delta", event_id: crypto.randomUUID(),
        delta: "Chau, seguimos cuando quieras.",
        start_ms: start, end_ms: start + 1,
      });
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
    socket.data.connectedAt = Date.now();
    send(socket.data, { type: "session.started" });
    if (socket.data.global) send(socket.data, {
      type: "session.input_transcript.delta", event_id: crypto.randomUUID(),
      delta: socket.data.resume ? "Continue the conversation we created, answer its pending question with Concise, then say chau and end this Voice session."
        : "Use the source work to create a task and a conversation in workspace B, and ask before continuing.",
      start_ms: 0, end_ms: 1,
    });
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
        session.journey = session.resume ? resumedJourney(session) : globalJourney();
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
