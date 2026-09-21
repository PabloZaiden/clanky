import { describe, expect, test } from "bun:test";

import { CapabilityService } from "../../src/backends/acp/capability-service";
import { AcpEventTranslator } from "../../src/backends/acp/event-translator";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import { SessionService } from "../../src/backends/acp/session-service";
import { SessionStateStore } from "../../src/backends/acp/session-state";
import type { AgentEvent, PromptInput } from "../../src/backends/types";
import type { JsonRpcMessage } from "../../src/backends/acp/types";

function createPrompt(): PromptInput {
  return {
    parts: [{ type: "text", text: "Continue" }],
  };
}

function createTranslator(): {
  state: SessionStateStore;
  translator: AcpEventTranslator;
  events: AgentEvent[];
} {
  const state = new SessionStateStore();
  const capability = new CapabilityService({
    async sendRequest<T>(_method: string, _params: Record<string, unknown>): Promise<T> {
      return {} as T;
    },
    writeMessage(_message: JsonRpcMessage): void {},
  });
  const translator = new AcpEventTranslator(state, capability);
  const events: AgentEvent[] = [];
  state.addSessionSubscriber("session-1", (event) => {
    events.push(event);
  });
  return { state, translator, events };
}

describe("ACP prompt completion", () => {
  test("does not treat an empty prompt response or early idle as terminal", async () => {
    let resolvePrompt: ((result: unknown) => void) | undefined;
    const requester: RpcRequester = {
      sendRequest<T>(method: string, _params: Record<string, unknown>): Promise<T> {
        if (method !== "session/prompt") {
          return Promise.resolve({} as T);
        }
        const result = new Promise<unknown>((resolve) => {
          resolvePrompt = resolve;
        });
        return result as Promise<T>;
      },
      writeMessage(_message: JsonRpcMessage): void {},
    };
    const state = new SessionStateStore();
    const capability = new CapabilityService(requester);
    const sessions = new SessionService(requester, state, capability, () => {});
    const events: AgentEvent[] = [];
    state.addSessionSubscriber("session-1", (event) => {
      events.push(event);
    });

    await sessions.sendPromptAsync("session-1", createPrompt());
    expect(resolvePrompt).toBeDefined();
    resolvePrompt?.({});
    await Promise.resolve();
    await Promise.resolve();

    const translator = new AcpEventTranslator(state, capability);
    translator.handleSessionStatus({ sessionId: "session-1", status: "idle" });
    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "El texto" },
      },
    });
    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: " completo" },
      },
    });

    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(0);
    expect(events
      .filter((event): event is Extract<AgentEvent, { type: "message.delta" }> => event.type === "message.delta")
      .map((event) => event.content)
      .join("")).toBe("El texto completo");

    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "end_turn",
      },
    });

    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(1);
    expect(state.hasActivePrompt("session-1")).toBe(false);
  });

  test("reconciles an explicit terminal signal received before the prompt acknowledgement", async () => {
    let resolvePrompt: ((result: unknown) => void) | undefined;
    const requester: RpcRequester = {
      sendRequest<T>(method: string, _params: Record<string, unknown>): Promise<T> {
        if (method !== "session/prompt") {
          return Promise.resolve({} as T);
        }
        return new Promise<unknown>((resolve) => {
          resolvePrompt = resolve;
        }) as Promise<T>;
      },
      writeMessage(_message: JsonRpcMessage): void {},
    };
    const state = new SessionStateStore();
    const capability = new CapabilityService(requester);
    const sessions = new SessionService(requester, state, capability, () => {});
    const translator = new AcpEventTranslator(state, capability);
    const events: AgentEvent[] = [];
    state.addSessionSubscriber("session-1", (event) => {
      events.push(event);
    });

    await sessions.sendPromptAsync("session-1", createPrompt());
    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: { sessionUpdate: "state_update", state: "idle" },
    });
    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(0);

    resolvePrompt?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(1);
    expect(state.hasActivePrompt("session-1")).toBe(false);
  });

  test("treats a prompt RPC stopReason as terminal", async () => {
    const requester: RpcRequester = {
      async sendRequest<T>(method: string, _params: Record<string, unknown>): Promise<T> {
        if (method === "session/prompt") {
          return { stopReason: "end_turn" } as T;
        }
        return {} as T;
      },
      writeMessage(_message: JsonRpcMessage): void {},
    };
    const state = new SessionStateStore();
    const capability = new CapabilityService(requester);
    const sessions = new SessionService(requester, state, capability, () => {});
    const events: AgentEvent[] = [];
    state.addSessionSubscriber("session-1", (event) => {
      events.push(event);
    });

    await sessions.sendPromptAsync("session-1", createPrompt());
    await Promise.resolve();
    await Promise.resolve();

    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(1);
    expect(state.hasActivePrompt("session-1")).toBe(false);
  });

  test("ignores session updates from an aborted prompt until the next prompt starts", () => {
    const { state, translator, events } = createTranslator();
    state.beginPrompt("session-1");
    state.markAborted("session-1");

    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "late output" },
      },
    });

    expect(events).toHaveLength(0);

    const nextSequence = state.beginPrompt("session-1");
    state.markPromptRpcAccepted("session-1", nextSequence);
    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "state_update",
        state: "idle",
      },
    });

    expect(events.filter((event) => event.type === "message.complete")).toHaveLength(1);
    expect(state.hasActivePrompt("session-1")).toBe(false);

    state.beginPrompt("session-1");
    translator.handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { text: "new output" },
      },
    });

    expect(events.some((event) => event.type === "message.delta" && event.content === "new output")).toBe(true);
  });
});
