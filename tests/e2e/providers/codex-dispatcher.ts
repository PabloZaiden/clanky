/**
 * Maps the supported app-server methods to the fixture state store.
 */

import type { ActiveTurn, CodexFixtureStore } from "./codex-state";
import { buildThread, buildTurn } from "./codex-protocol";

const MODEL_ID = "e2e-codex-model";

export interface CodexDispatchResult {
  result: unknown;
  turn?: ActiveTurn;
  interruptedTurn?: ActiveTurn;
  deletedThreadId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function listModels(): Record<string, unknown> {
  return {
    data: [{
      id: MODEL_ID,
      model: MODEL_ID,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "E2E Codex model",
      description: "Deterministic external Codex app-server fixture",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
      defaultReasoningEffort: "medium",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      multiAgentVersion: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: true,
    }],
    nextCursor: null,
  };
}

export class CodexMethodDispatcher {
  constructor(private readonly store: CodexFixtureStore) {}

  async dispatch(method: string, rawParams: unknown): Promise<CodexDispatchResult> {
    const params = requestParams(rawParams);
    switch (method) {
      case "initialize":
        return { result: { userAgent: "codex-cli 0.160.1" } };
      case "model/list":
        return { result: listModels() };
      case "config/read":
        return { result: { config: { features: { hooks: { enabled: true } } }, origins: {}, layers: null } };
      case "configRequirements/read":
        return { result: { requirements: null } };
      case "thread/start":
        return { result: { thread: buildThread(await this.store.createThread(params, MODEL_ID)) } };
      case "thread/resume":
        return { result: this.resumeThread(params) };
      case "thread/read":
        return { result: this.readThread(params) };
      case "thread/list":
        return { result: { data: [], nextCursor: null, backwardsCursor: null } };
      case "thread/turns/list":
        return { result: this.listTurns(params) };
      case "thread/items/list":
        return { result: this.listItems(params) };
      case "thread/backgroundTerminals/list":
        return { result: { data: [] } };
      case "thread/backgroundTerminals/terminate":
        return { result: { terminated: true } };
      case "thread/delete":
        return { result: {}, deletedThreadId: await this.store.deleteThread(params) };
      case "turn/start":
        return this.startTurn(params);
      case "turn/steer":
        return { result: await this.store.steer(params) };
      case "turn/interrupt":
        return { result: {}, interruptedTurn: await this.store.interruptTurn(params) };
      default:
        throw Object.assign(new Error(`Unsupported Codex fixture method: ${method}`), { code: -32601 });
    }
  }

  private resumeThread(params: Record<string, unknown>): Record<string, unknown> {
    const thread = this.store.resumeThread(params);
    return {
      thread: buildThread(thread, params["excludeTurns"] !== true),
      model: thread.model,
      modelProvider: "openai",
      serviceTier: null,
    };
  }

  private readThread(params: Record<string, unknown>): Record<string, unknown> {
    const thread = this.store.getThread(params);
    return { thread: buildThread(thread, params["includeTurns"] === true) };
  }

  private listTurns(params: Record<string, unknown>): Record<string, unknown> {
    const thread = this.store.getThread(params);
    const turns = params["sortDirection"] === "asc" ? thread.turns : [...thread.turns].reverse();
    return this.page(turns.map((turn) => params["itemsView"] === "notLoaded"
      ? { ...buildTurn(turn), items: [], itemsView: "notLoaded" }
      : buildTurn(turn)), params);
  }

  private listItems(params: Record<string, unknown>): Record<string, unknown> {
    const thread = this.store.getThread(params);
    const turn = thread.turns.find((entry) => entry.id === params["turnId"]);
    if (!turn) throw new Error("The requested native turn does not exist.");
    const items = params["sortDirection"] === "asc" ? turn.items : [...turn.items].reverse();
    return this.page(items.map((item) => {
      const id = isRecord(item) && typeof item["id"] === "string" ? item["id"] : "";
      return {
        turnId: turn.id, item,
        startedAtMs: turn.itemTimes[id]?.startedAtMs ?? null,
        completedAtMs: turn.itemTimes[id]?.completedAtMs ?? null,
      };
    }), params);
  }

  private page(data: unknown[], params: Record<string, unknown>): Record<string, unknown> {
    const start = Number(params["cursor"] ?? 0);
    const limit = typeof params["limit"] === "number" ? params["limit"] : 100;
    const end = Math.min(data.length, start + limit);
    return {
      data: data.slice(start, end),
      nextCursor: end < data.length ? String(end) : null,
      backwardsCursor: null,
    };
  }

  private async startTurn(params: Record<string, unknown>): Promise<CodexDispatchResult> {
    const turn = await this.store.beginTurn(params);
    return { result: { turn: buildTurn(turn.turn) }, turn };
  }
}
