/**
 * Owns persisted threads and turns for the external Codex E2E fixture.
 */

import { randomUUID } from "node:crypto";

export interface PersistedTurn {
  completedAt: number | null;
  error: { message: string } | null;
  id: string;
  items: unknown[];
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
  return {
    id: requireString(value["id"], "turn id"),
    status,
    items: Array.isArray(value["items"]) ? value["items"] : [],
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
  };
}

export class CodexFixtureStore {
  private readonly steering = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
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
      startedAt: now,
      completedAt: null,
      error: null,
    };
    thread.status = "active";
    thread.updatedAt = now;
    thread.turns.push(turn);
    await this.persist();
    if (JSON.stringify(params["input"]).includes("Wait for a steering instruction")) {
      this.steering.set(turn.id, Promise.withResolvers<string>());
    }
    return { thread, turn };
  }

  async waitForSteering(active: ActiveTurn): Promise<string | undefined> {
    const pending = this.steering.get(active.turn.id);
    if (!pending) return undefined;
    const timer = setTimeout(() => pending.reject(new Error("Steering instruction did not arrive.")), 10_000);
    try {
      return await pending.promise;
    } finally {
      clearTimeout(timer);
      this.steering.delete(active.turn.id);
    }
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
    this.steering.get(turn.id)?.resolve(JSON.stringify(content));
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

  async deleteThread(params: Record<string, unknown>): Promise<void> {
    const threadId = requireString(params["threadId"], "delete thread id");
    delete this.state.threads[threadId];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await Bun.write(this.statePath, JSON.stringify(this.state));
  }
}
