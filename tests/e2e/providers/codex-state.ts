/**
 * Owns persisted threads and turns for the external Codex E2E fixture.
 */

import { randomUUID } from "node:crypto";

export interface PersistedTurn {
  completedAt: number | null;
  error: { message: string } | null;
  id: string;
  items: unknown[];
  itemTimes: Record<string, { startedAtMs: number | null; completedAtMs: number | null }>;
  startedAt: number;
  status: "completed" | "failed" | "inProgress" | "interrupted";
}

export interface PersistedThread {
  createdAt: number;
  cwd: string;
  dynamicTools: unknown[];
  id: string;
  model: string;
  status: "active" | "idle";
  turns: PersistedTurn[];
  updatedAt: number;
  backgroundResult?: string;
  parentThreadId?: string;
}

export interface ActiveTurn {
  thread: PersistedThread;
  turn: PersistedTurn;
}

interface PersistedState {
  threads: Record<string, PersistedThread>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The persisted Codex fixture ${name} is invalid.`);
  }
  return value;
}

function parseTurn(value: unknown): PersistedTurn {
  if (!isRecord(value)) {
    throw new Error("The persisted Codex fixture turn is invalid.");
  }
  const status = value["status"];
  if (
    status !== "completed"
    && status !== "failed"
    && status !== "inProgress"
    && status !== "interrupted"
  ) {
    throw new Error("The persisted Codex fixture turn status is invalid.");
  }
  const itemTimes: PersistedTurn["itemTimes"] = {};
  if (isRecord(value["itemTimes"])) {
    for (const [id, entry] of Object.entries(value["itemTimes"])) {
      if (!isRecord(entry)) continue;
      itemTimes[id] = {
        startedAtMs: typeof entry["startedAtMs"] === "number" ? entry["startedAtMs"] : null,
        completedAtMs: typeof entry["completedAtMs"] === "number" ? entry["completedAtMs"] : null,
      };
    }
  }
  return {
    id: requireString(value["id"], "turn id"),
    status,
    items: Array.isArray(value["items"]) ? value["items"] : [],
    itemTimes,
    startedAt: typeof value["startedAt"] === "number" ? value["startedAt"] : 0,
    completedAt: typeof value["completedAt"] === "number" ? value["completedAt"] : null,
    error: isRecord(value["error"]) && typeof value["error"]["message"] === "string"
      ? { message: value["error"]["message"] }
      : null,
  };
}

function parseThread(value: unknown): PersistedThread {
  if (!isRecord(value)) {
    throw new Error("The persisted Codex fixture thread is invalid.");
  }
  const status = value["status"];
  if (status !== "active" && status !== "idle") {
    throw new Error("The persisted Codex fixture thread status is invalid.");
  }
  return {
    id: requireString(value["id"], "thread id"),
    cwd: requireString(value["cwd"], "thread cwd"),
    model: requireString(value["model"], "thread model"),
    createdAt: typeof value["createdAt"] === "number" ? value["createdAt"] : 0,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : 0,
    status,
    dynamicTools: Array.isArray(value["dynamicTools"]) ? value["dynamicTools"] : [],
    turns: Array.isArray(value["turns"]) ? value["turns"].map(parseTurn) : [],
    backgroundResult: typeof value["backgroundResult"] === "string" ? value["backgroundResult"] : undefined,
    parentThreadId: typeof value["parentThreadId"] === "string" ? value["parentThreadId"] : undefined,
  };
}

export class CodexFixtureStore {
  private readonly steering = new Map<string, ReturnType<typeof Promise.withResolvers<string | undefined>>>();
  private readonly backgrounds = new Map<string, {
    controller: AbortController;
    finished: ReturnType<typeof Promise.withResolvers<void>>;
  }>();
  private constructor(
    private readonly statePath: string,
    private readonly state: PersistedState,
  ) {}

  static async open(statePath: string): Promise<CodexFixtureStore> {
    const file = Bun.file(statePath);
    if (!(await file.exists())) {
      return new CodexFixtureStore(statePath, { threads: {} });
    }

    const value: unknown = JSON.parse(await file.text());
    if (!isRecord(value) || !isRecord(value["threads"])) {
      throw new Error("The persisted Codex fixture state is invalid.");
    }
    const threads: Record<string, PersistedThread> = {};
    for (const [id, thread] of Object.entries(value["threads"])) {
      threads[id] = parseThread(thread);
    }
    return new CodexFixtureStore(statePath, { threads });
  }

  getThread(params: Record<string, unknown>): PersistedThread {
    const threadId = requireString(params["threadId"], "request thread id");
    const thread = this.state.threads[threadId];
    if (!thread) {
      throw new Error(`The Codex fixture thread ${threadId} does not exist.`);
    }

    return thread;
  }

  childThreads(parentId: string): PersistedThread[] {
    return Object.values(this.state.threads).filter((thread) => thread.parentThreadId === parentId);
  }

  async createThread(params: Record<string, unknown>, defaultModel: string): Promise<PersistedThread> {
    const now = Date.now() / 1000;
    const thread: PersistedThread = {
      id: randomUUID(),
      cwd: typeof params["cwd"] === "string" ? params["cwd"] : process.cwd(),
      model: typeof params["model"] === "string" ? params["model"] : defaultModel,
      createdAt: now,
      updatedAt: now,
      status: "idle",
      dynamicTools: Array.isArray(params["dynamicTools"]) ? params["dynamicTools"] : [],
      turns: [],
      parentThreadId: typeof params["parentThreadId"] === "string" ? params["parentThreadId"] : undefined,
    };
    this.state.threads[thread.id] = thread;
    await this.persist();
    return thread;
  }

  resumeThread(params: Record<string, unknown>): PersistedThread {
    const thread = this.getThread(params);
    thread.status = "idle";
    return thread;
  }

  async beginTurn(params: Record<string, unknown>): Promise<ActiveTurn> {
    const thread = this.getThread(params);
    if (thread.status !== "idle") {
      throw new Error("The Codex fixture thread already has an active turn.");
    }
    const now = Date.now() / 1000;
    const turn: PersistedTurn = {
      id: randomUUID(),
      status: "inProgress",
      items: [{ type: "userMessage", id: randomUUID(), clientId: null, content: params["input"] ?? [] }],
      itemTimes: {},
      startedAt: now,
      completedAt: null,
      error: null,
    };
    thread.status = "active";
    thread.updatedAt = now;
    thread.turns.push(turn);
    await this.persist();
    if (JSON.stringify(params["input"]).includes("Wait for a steering instruction")) {
      this.steering.set(turn.id, Promise.withResolvers<string | undefined>());
    }
    return { thread, turn };
  }

  async waitForSteering(active: ActiveTurn): Promise<string | undefined> {
    const pending = this.steering.get(active.turn.id);
    if (!pending) return undefined;
    try {
      return await pending.promise;
    } finally {
      this.steering.delete(active.turn.id);
    }
  }

  async interruptTurn(params: Record<string, unknown>): Promise<ActiveTurn | undefined> {
    const thread = this.getThread(params);
    const turnId = requireString(params["turnId"], "interrupt turn id");
    const turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn) {
      throw Object.assign(new Error("The requested turn does not exist."), { code: -32600 });
    }
    if (turn.status !== "inProgress") return undefined;
    const active = { thread, turn };
    this.markInterrupted(active);
    await this.stopBackground(thread.id);
    await this.persist();
    return active;
  }

  async close(): Promise<void> {
    await Promise.all([...this.backgrounds.keys()].map((id) => this.stopBackground(id)));
    let changed = false;
    for (const thread of Object.values(this.state.threads)) {
      for (const turn of thread.turns) {
        if (turn.status !== "inProgress") continue;
        this.markInterrupted({ thread, turn });
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private markInterrupted({ thread, turn }: ActiveTurn): void {
    this.backgrounds.get(thread.id)?.controller.abort();
    const now = Date.now() / 1000;
    turn.status = "interrupted";
    turn.completedAt = now;
    thread.status = "idle";
    thread.updatedAt = now;
    this.steering.get(turn.id)?.resolve(undefined);
    this.steering.delete(turn.id);
  }

  async steer(params: Record<string, unknown>): Promise<{ turnId: string }> {
    const thread = this.getThread(params);
    const turn = thread.turns.at(-1);
    if (!turn || turn.status !== "inProgress" || turn.id !== params["expectedTurnId"]) {
      throw Object.assign(new Error("The active turn changed."), { code: -32600 });
    }
    const content = Array.isArray(params["input"]) ? params["input"] : [];
    turn.items.push({
      type: "userMessage", id: randomUUID(), clientId: params["clientUserMessageId"], content,
    });
    await this.persist();
    const instruction = content.flatMap((part) => {
      if (!isRecord(part) || part["type"] !== "text" || typeof part["text"] !== "string") {
        return [];
      }
      return [part["text"]];
    }).join("\n");
    this.steering.get(turn.id)?.resolve(instruction);
    return { turnId: turn.id };
  }

  async completeTurn(active: ActiveTurn): Promise<void> {
    const completedAt = Date.now() / 1000;
    active.turn.status = "completed";
    active.turn.completedAt = completedAt;
    active.thread.status = "idle";
    active.thread.updatedAt = completedAt;
    await this.persist();
  }

  async failTurn(active: ActiveTurn, error: unknown): Promise<void> {
    const failedAt = Date.now() / 1000;
    active.thread.status = "idle";
    active.thread.updatedAt = failedAt;
    active.turn.status = "failed";
    active.turn.completedAt = failedAt;
    active.turn.error = { message: String(error) };
    await this.persist();
  }

  async deleteThread(params: Record<string, unknown>): Promise<string> {
    const thread = this.getThread(params);
    await this.stopBackground(thread.id);
    for (const turn of thread.turns) {
      if (turn.status === "inProgress") this.markInterrupted({ thread, turn });
    }
    delete this.state.threads[thread.id];
    await this.persist();
    return thread.id;
  }

  ownBackground(threadId: string): AbortController {
    const controller = new AbortController();
    if (this.backgrounds.has(threadId)) throw new Error("A native background process is already owned by this thread.");
    this.backgrounds.set(threadId, { controller, finished: Promise.withResolvers<void>() });
    return controller;
  }

  releaseBackground(threadId: string, controller: AbortController): void {
    const background = this.backgrounds.get(threadId);
    if (background?.controller !== controller) return;
    this.backgrounds.delete(threadId);
    background.finished.resolve();
  }

  private async stopBackground(threadId: string): Promise<void> {
    const background = this.backgrounds.get(threadId);
    background?.controller.abort();
    await background?.finished.promise;
  }

  async persist(): Promise<void> {
    await Bun.write(this.statePath, JSON.stringify(this.state));
  }
}
