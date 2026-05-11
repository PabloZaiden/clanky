/**
 * Unit tests for AcpBackend.
 * 
 * Note: These tests verify the class structure and basic behaviors.
 * Integration tests that actually connect to a provider runtime are in tests/api/.
 */

import { test, expect, describe, beforeEach } from "bun:test";
import {
  AcpBackend,
  isTransientSshAuthenticationFailure,
  sanitizeSpawnArgsForLogging,
} from "../../src/backends/acp";

describe("AcpBackend", () => {
  let backend: AcpBackend;

  beforeEach(() => {
    backend = new AcpBackend();
  });

  test("has correct name", () => {
    expect(backend.name).toBe("acp");
  });

  test("isConnected returns false initially", () => {
    expect(backend.isConnected()).toBe(false);
  });

  test("disconnect on unconnected backend does nothing", async () => {
    // Should not throw
    await backend.disconnect();
    expect(backend.isConnected()).toBe(false);
  });

  test("disconnect terminates a running ACP subprocess", async () => {
    let exitCode: number | null = null;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = (code: number) => {
        exitCode = code;
        resolve(code);
      };
    });
    const killSignals: Array<number | NodeJS.Signals | undefined> = [];

    const fakeProcess = {
      exited,
      get exitCode() {
        return exitCode;
      },
      kill(signal?: number | NodeJS.Signals) {
        killSignals.push(signal);
        resolveExit(signal === "SIGKILL" ? 137 : 0);
      },
    } as unknown as Bun.Subprocess;

    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | null;
    };
    internal.connected = true;
    internal.process = fakeProcess;

    await backend.disconnect();

    expect(killSignals).toEqual(["SIGTERM"]);
    expect(backend.isConnected()).toBe(false);
  });

  test("detects transient SSH auth failures from ACP initialization", () => {
    expect(
      isTransientSshAuthenticationFailure(
        new Error(
          "ACP process exited with code 255: [stderr] vscode@localhost: Permission denied (publickey,password,keyboard-interactive).",
        ),
      ),
    ).toBe(true);
    expect(
      isTransientSshAuthenticationFailure(
        new Error("ACP process exited with code 1: [stderr] bash: no job control in this shell"),
      ),
    ).toBe(false);
  });

  test("throws when createSession called before connect", async () => {
    await expect(
      backend.createSession({ directory: "/tmp" })
    ).rejects.toThrow("Not connected");
  });

  test("throws when getSession called before connect", async () => {
    await expect(backend.getSession("test-id")).rejects.toThrow("Not connected");
  });

  test("getSession loads a listed session before returning it", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.directory = "/tmp/copilot-session-load";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "session/list") {
        return {
          sessions: [
            {
              sessionId: "resume-me",
              title: "Resume me",
              cwd: "/tmp/copilot-session-load",
            },
          ],
        };
      }
      if (method === "session/load") {
        return {
          sessionId: "resume-me",
          title: "Loaded session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5-mini",
              category: "model",
              options: [
                {
                  value: "gpt-5-mini",
                  name: "GPT-5 mini",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const session = await backend.getSession("resume-me");

    expect(calls.map((call) => call.method)).toEqual(["session/list", "session/load"]);
    expect(calls[1]?.params).toEqual({
      sessionId: "resume-me",
      cwd: "/tmp/copilot-session-load",
      mcpServers: [],
    });
    expect(session).toMatchObject({
      id: "resume-me",
      title: "Loaded session",
      model: "gpt-5-mini",
    });
  });

  test("getSession keys Copilot hydrated cache metadata by the loaded session directory", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      modelCache: Map<string, { models: Array<{ modelID: string; name?: string; variants: string[] }>; complete: boolean }>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/backend-directory";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "session/list") {
        return {
          sessions: [
            {
              sessionId: "resume-me",
              title: "Resume me",
              cwd: "/tmp/loaded-session-directory",
            },
          ],
        };
      }
      if (method === "session/load") {
        expect(params).toEqual({
          sessionId: "resume-me",
          cwd: "/tmp/loaded-session-directory",
          mcpServers: [],
        });
        return {
          sessionId: "resume-me",
          title: "Loaded session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    await backend.getSession("resume-me");

    expect(internal.modelCache.get("/tmp/loaded-session-directory")).toMatchObject({
      models: [
        { modelID: "auto", variants: [""] },
        { modelID: "gpt-5.4", variants: [""] },
      ],
      complete: false,
    });
    expect(internal.modelCache.has("/tmp/backend-directory")).toBe(false);
    expect(
      internal.defaultReasoningEfforts.get("/tmp/loaded-session-directory")?.get("gpt-5.4"),
    ).toBe("medium");
    expect(internal.defaultReasoningEfforts.has("/tmp/backend-directory")).toBe(false);
  });

  test("getSession returns null when session/load says the listed session is not found", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.sendRpcRequest = async (method: string): Promise<unknown> => {
      if (method === "session/list") {
        return {
          sessions: [
            {
              sessionId: "resume-me",
              title: "Resume me",
              cwd: "/tmp/copilot-session-load",
            },
          ],
        };
      }
      if (method === "session/load") {
        throw new Error("Session resume-me not found");
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    await expect(backend.getSession("resume-me")).resolves.toBeNull();
  });

  test("throws when deleteSession called before connect", async () => {
    await expect(backend.deleteSession("test-id")).rejects.toThrow("Not connected");
  });

  test("throws when sendPrompt called before connect", async () => {
    await expect(
      backend.sendPrompt("test-id", { parts: [{ type: "text", text: "test" }] })
    ).rejects.toThrow("Not connected");
  });

  test("throws when sendPromptAsync called before connect", async () => {
    await expect(
      backend.sendPromptAsync("test-id", { parts: [{ type: "text", text: "test" }] })
    ).rejects.toThrow("Not connected");
  });

  test("throws when abortSession called before connect", async () => {
    await expect(backend.abortSession("test-id")).rejects.toThrow("Not connected");
  });

  test("abortSession falls back through supported ACP cancellation methods", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      sendRpcRequest: (method: string, params: { sessionId: string }, timeoutMs: number) => Promise<void>;
    };

    const attemptedMethods: string[] = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.sendRpcRequest = async (method: string): Promise<void> => {
      attemptedMethods.push(method);
      if (method === "session/cancel") {
        throw new Error("Method not found");
      }
      if (method === "session/abort") {
        throw new Error("RPC error -32601");
      }
    };

    await backend.abortSession("test-session");

    expect(attemptedMethods).toEqual([
      "session/cancel",
      "session/abort",
      "session/stop",
    ]);
  });

  test("abortSession rethrows non-method-not-found errors", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      sendRpcRequest: (method: string, params: { sessionId: string }, timeoutMs: number) => Promise<void>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.sendRpcRequest = async (): Promise<void> => {
      throw new Error("transport disconnected");
    };

    await expect(backend.abortSession("test-session")).rejects.toThrow("transport disconnected");
  });

  test("getModels discovers Copilot reasoning-effort variants per model", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/copilot-models";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "session/new") {
        return {
          sessionId: "discovery-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "auto",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
                { value: "gpt-4.1", name: "GPT-4.1" },
              ],
            },
          ],
        };
      }
      if (method === "session/set_config_option" && params["configId"] === "model" && params["value"] === "gpt-5.4") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
                { value: "gpt-4.1", name: "GPT-4.1" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/set_config_option" && params["configId"] === "model" && params["value"] === "gpt-4.1") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-4.1",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
                { value: "gpt-4.1", name: "GPT-4.1" },
              ],
            },
          ],
        };
      }
      if (method === "session/delete") {
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const models = await backend.getModels("/tmp/copilot-models");

    expect(models.map((model) => ({
      modelID: model.modelID,
      variants: model.variants,
    }))).toEqual([
      { modelID: "auto", variants: [""] },
      { modelID: "gpt-5.4", variants: ["medium", "low", "high"] },
      { modelID: "gpt-4.1", variants: [""] },
    ]);
    expect(
      internal.defaultReasoningEfforts.get("/tmp/copilot-models")?.get("gpt-5.4"),
    ).toBe("medium");
  });

  test("getModels discovers OpenCode reasoning-effort variants from config options", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "opencode";
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
    };

    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "opencode";
    internal.directory = "/tmp/opencode-models";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (method === "session/new") {
        return {
          sessionId: "opencode-discovery-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "anthropic/claude-sonnet-4-5",
              category: "model",
              options: [
                { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                { value: "openai/gpt-5.4", name: "GPT-5.4" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "reasoning_effort",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (
        method === "session/set_config_option"
        && params["configId"] === "model"
        && params["value"] === "openai/gpt-5.4"
      ) {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "openai/gpt-5.4",
              category: "model",
              options: [
                { value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
                { value: "openai/gpt-5.4", name: "GPT-5.4" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "reasoning_effort",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/delete") {
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const models = await backend.getModels("/tmp/opencode-models");

    expect(models.map((model) => ({
      providerID: model.providerID,
      modelID: model.modelID,
      variants: model.variants,
    }))).toEqual([
      { providerID: "anthropic", modelID: "anthropic/claude-sonnet-4-5", variants: ["medium", "low", "high"] },
      { providerID: "openai", modelID: "openai/gpt-5.4", variants: ["medium", "low", "high"] },
    ]);
  });

  test("getModels ignores incomplete Copilot cache seeded by createSession", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
    };

    const calls: string[] = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/copilot-create-first";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === "session/new" && calls.filter((call) => call === "session/new").length === 1) {
        return {
          sessionId: "seed-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "auto",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
          ],
        };
      }
      if (method === "session/new") {
        return {
          sessionId: "discovery-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "auto",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
          ],
        };
      }
      if (method === "session/set_config_option" && params["configId"] === "model" && params["value"] === "gpt-5.4") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/delete") {
        return {};
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    await backend.createSession({ directory: "/tmp/copilot-create-first", title: "Seed cache" });
    const models = await backend.getModels("/tmp/copilot-create-first");

    expect(models.map((model) => ({
      modelID: model.modelID,
      variants: model.variants,
    }))).toEqual([
      { modelID: "auto", variants: [""] },
      { modelID: "gpt-5.4", variants: ["medium", "low", "high"] },
    ]);
    expect(calls).toEqual([
      "session/new",
      "session/new",
      "session/set_config_option",
      "session/delete",
    ]);
  });

  test("hydrated Copilot sessions do not downgrade a fully discovered model cache", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sendRpcRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
    };

    const calls: string[] = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/copilot-hydrate-after-discovery";
    internal.sendRpcRequest = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push(method);
      if (method === "session/new") {
        return {
          sessionId: "discovery-session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "auto",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
          ],
        };
      }
      if (method === "session/set_config_option" && params["configId"] === "model" && params["value"] === "gpt-5.4") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: "medium",
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/delete") {
        return {};
      }
      if (method === "session/list") {
        return {
          sessions: [
            {
              sessionId: "resume-me",
              title: "Resume me",
              cwd: "/tmp/copilot-hydrate-after-discovery",
            },
          ],
        };
      }
      if (method === "session/load") {
        return {
          sessionId: "resume-me",
          title: "Loaded session",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [
                { value: "auto", name: "Auto" },
                { value: "gpt-5.4", name: "GPT-5.4" },
              ],
            },
          ],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const discoveredModels = await backend.getModels("/tmp/copilot-hydrate-after-discovery");
    await backend.getSession("resume-me");
    const cachedModels = await backend.getModels("/tmp/copilot-hydrate-after-discovery");

    expect(discoveredModels).toEqual(cachedModels);
    expect(cachedModels.map((model) => ({
      modelID: model.modelID,
      variants: model.variants,
    }))).toEqual([
      { modelID: "auto", variants: [""] },
      { modelID: "gpt-5.4", variants: ["medium", "low", "high"] },
    ]);
    expect(calls).toEqual([
      "session/new",
      "session/set_config_option",
      "session/delete",
      "session/list",
      "session/load",
    ]);
  });

  test("sendPrompt applies Copilot reasoning effort from model variant", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sessionCache: Map<string, {
        id: string;
        createdAt: string;
        model?: string;
        configOptions?: Array<Record<string, unknown>>;
      }>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
      sendRpcRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    };

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/copilot-prompt";
    internal.sessionCache.set("session-1", {
      id: "session-1",
      createdAt: new Date().toISOString(),
      model: "gpt-5.4",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gpt-5.4",
          category: "model",
          options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "medium",
          category: "thought_level",
          options: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
          ],
        },
      ],
    });
    internal.defaultReasoningEfforts.set("/tmp/copilot-prompt", new Map([["gpt-5.4", "medium"]]));
    internal.sendRpcRequest = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "session/set_config_option") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: params["value"],
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/prompt") {
        return { content: "OK" };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const response = await backend.sendPrompt("session-1", {
      parts: [{ type: "text", text: "test" }],
      model: {
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "high",
      },
    });

    expect(calls).toEqual([
      {
        method: "session/set_config_option",
        params: {
          sessionId: "session-1",
          configId: "reasoning_effort",
          value: "high",
        },
      },
      {
        method: "session/prompt",
        params: {
          sessionId: "session-1",
          prompt: [{ type: "text", text: "test" }],
          model: "gpt-5.4",
        },
      },
    ]);
    expect(response.content).toBe("OK");
  });

  test("sendPrompt applies OpenCode reasoning effort from model variant", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "opencode";
      directory: string;
      sessionCache: Map<string, {
        id: string;
        createdAt: string;
        model?: string;
        configOptions?: Array<Record<string, unknown>>;
      }>;
      sendRpcRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    };

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "opencode";
    internal.directory = "/tmp/opencode-prompt";
    internal.sessionCache.set("session-opencode", {
      id: "session-opencode",
      createdAt: new Date().toISOString(),
      model: "anthropic/claude-sonnet-4-5",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "anthropic/claude-sonnet-4-5",
          category: "model",
          options: [{ value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "medium",
          category: "reasoning_effort",
          options: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
          ],
        },
      ],
    });
    internal.sendRpcRequest = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "session/set_config_option") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "anthropic/claude-sonnet-4-5",
              category: "model",
              options: [{ value: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: params["value"],
              category: "reasoning_effort",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/prompt") {
        return { content: "OK" };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    const response = await backend.sendPrompt("session-opencode", {
      parts: [{ type: "text", text: "test" }],
      model: {
        providerID: "anthropic",
        modelID: "anthropic/claude-sonnet-4-5",
        variant: "high",
      },
    });

    expect(calls).toEqual([
      {
        method: "session/set_config_option",
        params: {
          sessionId: "session-opencode",
          configId: "reasoning_effort",
          value: "high",
        },
      },
      {
        method: "session/prompt",
        params: {
          sessionId: "session-opencode",
          prompt: [{ type: "text", text: "test" }],
          model: "anthropic/claude-sonnet-4-5",
        },
      },
    ]);
    expect(response.content).toBe("OK");
  });

  test("sendPrompt resets OpenCode reasoning effort using the created session directory", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "opencode";
      directory: string;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
      sendRpcRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    };

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "opencode";
    internal.directory = "/tmp/backend-connect-directory";
    const modelID = "anthropic/claude-sonnet-4-5";
    const configOptionsForEffort = (effort: string): Array<Record<string, unknown>> => [
      {
        id: "model",
        name: "Model",
        type: "select",
        currentValue: modelID,
        category: "model",
        options: [{ value: modelID, name: "Claude Sonnet 4.5" }],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning Effort",
        type: "select",
        currentValue: effort,
        category: "reasoning_effort",
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ];
    internal.sendRpcRequest = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "session/new") {
        expect(params["cwd"]).toBe("/tmp/session-cwd");
        return {
          sessionId: "session-with-custom-cwd",
          cwd: "/tmp/session-cwd",
          configOptions: configOptionsForEffort("medium"),
        };
      }
      if (method === "session/set_config_option") {
        return {
          configOptions: configOptionsForEffort(String(params["value"])),
        };
      }
      if (method === "session/prompt") {
        return { content: "OK" };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    await backend.createSession({ directory: "/tmp/session-cwd" });
    await backend.sendPrompt("session-with-custom-cwd", {
      parts: [{ type: "text", text: "use high" }],
      model: {
        providerID: "anthropic",
        modelID,
        variant: "high",
      },
    });
    await backend.sendPrompt("session-with-custom-cwd", {
      parts: [{ type: "text", text: "reset" }],
      model: {
        providerID: "anthropic",
        modelID,
        variant: "",
      },
    });

    expect(
      internal.defaultReasoningEfforts.get("/tmp/session-cwd")?.get(modelID),
    ).toBe("medium");
    expect(internal.defaultReasoningEfforts.has("/tmp/backend-connect-directory")).toBe(false);
    expect(
      calls
        .filter((call) => call.method === "session/set_config_option")
        .map((call) => call.params["value"]),
    ).toEqual(["high", "medium"]);
  });

  test("sendPrompt resets Copilot effort to cached default for the base variant", async () => {
    const internal = backend as unknown as {
      connected: boolean;
      process: Bun.Subprocess | Record<string, never> | null;
      provider: "copilot";
      directory: string;
      sessionCache: Map<string, {
        id: string;
        createdAt: string;
        model?: string;
        configOptions?: Array<Record<string, unknown>>;
      }>;
      defaultReasoningEfforts: Map<string, Map<string, string>>;
      sendRpcRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    };

    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    internal.connected = true;
    internal.process = {} as Record<string, never>;
    internal.provider = "copilot";
    internal.directory = "/tmp/copilot-reset";
    internal.sessionCache.set("session-2", {
      id: "session-2",
      createdAt: new Date().toISOString(),
      model: "gpt-5.4",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gpt-5.4",
          category: "model",
          options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          type: "select",
          currentValue: "high",
          category: "thought_level",
          options: [
            { value: "low", name: "low" },
            { value: "medium", name: "medium" },
            { value: "high", name: "high" },
          ],
        },
      ],
    });
    internal.defaultReasoningEfforts.set("/tmp/copilot-reset", new Map([["gpt-5.4", "medium"]]));
    internal.sendRpcRequest = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      calls.push({ method, params });
      if (method === "session/set_config_option") {
        return {
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              currentValue: "gpt-5.4",
              category: "model",
              options: [{ value: "gpt-5.4", name: "GPT-5.4" }],
            },
            {
              id: "reasoning_effort",
              name: "Reasoning Effort",
              type: "select",
              currentValue: params["value"],
              category: "thought_level",
              options: [
                { value: "low", name: "low" },
                { value: "medium", name: "medium" },
                { value: "high", name: "high" },
              ],
            },
          ],
        };
      }
      if (method === "session/prompt") {
        return { content: "OK" };
      }
      throw new Error(`Unexpected method: ${method}`);
    };

    await backend.sendPrompt("session-2", {
      parts: [{ type: "text", text: "test" }],
      model: {
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "",
      },
    });

    expect(calls[0]).toEqual({
      method: "session/set_config_option",
      params: {
        sessionId: "session-2",
        configId: "reasoning_effort",
        value: "medium",
      },
    });
  });
});

describe("sanitizeSpawnArgsForLogging", () => {
  test("masks only sshpass password argument values", () => {
    const args = [
      "-p",
      "super-secret-password",
      "ssh",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-p",
      "5001",
      "host",
      "--",
      "bash -lc 'copilot --yolo --acp'",
    ];

    const sanitized = sanitizeSpawnArgsForLogging("sshpass", args);

    expect(sanitized).toEqual([
      "-p",
      "***",
      "ssh",
      "-o",
      "NumberOfPasswordPrompts=1",
      "-p",
      "5001",
      "host",
      "--",
      "bash -lc 'copilot --yolo --acp'",
    ]);
    expect(args[1]).toBe("super-secret-password");
  });

  test("leaves non-sshpass commands unchanged", () => {
    const args = ["-o", "BatchMode=yes", "-p", "5001", "host"];
    const sanitized = sanitizeSpawnArgsForLogging("ssh", args);
    expect(sanitized).toBe(args);
  });
});

describe("AcpBackend Connection Config", () => {
  test("connect rejects when already connected", async () => {
    const backend = new AcpBackend();
    
    // We can't actually connect without a server, but we can test the double-connect check
    // by mocking the internal state. For now, we test that connect with invalid config fails.
    // This is more of an integration test scenario.
    
    // Try to connect to a non-existent server (will fail, which is expected)
    const config = {
      mode: "connect" as const,
      hostname: "localhost",
      port: 59999, // Unlikely to be used
      directory: "/tmp",
    };

    // This should fail because no server is running
    await expect(backend.connect(config)).rejects.toThrow();
  });
});

describe("AcpBackend abortAllSubscriptions", () => {
  test("abortAllSubscriptions works when no subscriptions exist", () => {
    const backend = new AcpBackend();
    
    // Should not throw when called with no active subscriptions
    expect(() => backend.abortAllSubscriptions()).not.toThrow();
  });

  test("abortAllSubscriptions aborts all tracked subscriptions", () => {
    const backend = new AcpBackend();
    
    // Access the private activeSubscriptions set via type assertion
    const b = backend as unknown as { activeSubscriptions: Set<AbortController> };
    
    // Create mock AbortControllers
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const controller3 = new AbortController();
    
    // Track abort calls by checking signal.aborted after calling abort
    b.activeSubscriptions.add(controller1);
    b.activeSubscriptions.add(controller2);
    b.activeSubscriptions.add(controller3);
    
    expect(b.activeSubscriptions.size).toBe(3);
    expect(controller1.signal.aborted).toBe(false);
    expect(controller2.signal.aborted).toBe(false);
    expect(controller3.signal.aborted).toBe(false);
    
    // Call abortAllSubscriptions
    backend.abortAllSubscriptions();
    
    // Verify all controllers were aborted
    expect(controller1.signal.aborted).toBe(true);
    expect(controller2.signal.aborted).toBe(true);
    expect(controller3.signal.aborted).toBe(true);
    
    // Verify the set was cleared
    expect(b.activeSubscriptions.size).toBe(0);
  });

  test("abortAllSubscriptions clears the subscription set", () => {
    const backend = new AcpBackend();
    
    // Access the private activeSubscriptions set
    const b = backend as unknown as { activeSubscriptions: Set<AbortController> };
    
    // Add some controllers
    b.activeSubscriptions.add(new AbortController());
    b.activeSubscriptions.add(new AbortController());
    
    expect(b.activeSubscriptions.size).toBe(2);
    
    backend.abortAllSubscriptions();
    
    expect(b.activeSubscriptions.size).toBe(0);
  });
});

describe("AcpBackend replyToPermission", () => {
  test("throws when replyToPermission called before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-123", "once")
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToPermission called with 'always' before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-456", "always")
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToPermission called with 'reject' before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToPermission("request-789", "reject")
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend replyToQuestion", () => {
  test("throws when replyToQuestion called before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-123", [["answer1"]])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with multiple answers before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-456", [["option1", "option2"], ["choice1"]])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with empty answers before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-789", [])
    ).rejects.toThrow("Not connected");
  });

  test("throws when replyToQuestion called with empty answer arrays before connect", async () => {
    const backend = new AcpBackend();
    
    await expect(
      backend.replyToQuestion("question-101", [[], []])
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend transport validation", () => {
  test("getConnectionInfo returns null when not connected", () => {
    const backend = new AcpBackend();
    expect(backend.getConnectionInfo()).toBe(null);
  });

  test("connect mode is rejected by ACP runtime", async () => {
    const backend = new AcpBackend();
    const config = {
      mode: "connect" as const,
      hostname: "test-server.example.com",
      port: 4096,
      directory: "/tmp",
    };

    await expect(backend.connect(config)).rejects.toThrow(
      "Connect mode is not supported by ACP runtime. Use stdio or ssh transport."
    );
    expect(backend.isConnected()).toBe(false);
  });

  test("connect mode with legacy HTTPS fields is still rejected", async () => {
    const backend = new AcpBackend();
    const config = {
      mode: "connect" as const,
      hostname: "test-server.example.com",
      port: 8443,
      directory: "/tmp",
    };

    await expect(backend.connect(config)).rejects.toThrow(
      "Connect mode is not supported by ACP runtime. Use stdio or ssh transport."
    );
    expect(backend.isConnected()).toBe(false);
  });
});

describe("AcpBackend spawn cwd selection", () => {
  test("uses root cwd for ssh transport spawn", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCwd: string | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const options = (args.length === 1 ? args[0] : args[1]) as { cwd?: string } | undefined;
      capturedCwd = options?.cwd;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-only-path",
        }),
      ).rejects.toThrow("Failed to spawn ACP process");
      expect(capturedCwd).toBe("/");
      expect(backend.isConnected()).toBe(false);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("uses configured cwd for stdio transport spawn", async () => {
    const originalSpawn = Bun.spawn;
    let capturedCwd: string | undefined;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: unknown[]) => {
      const options = (args.length === 1 ? args[0] : args[1]) as { cwd?: string } | undefined;
      capturedCwd = options?.cwd;
      throw new Error("mock spawn failure");
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "stdio",
          command: "copilot",
          args: ["--yolo", "--acp"],
          directory: "/tmp/stdio-workdir",
        }),
      ).rejects.toThrow("Failed to spawn ACP process");
      expect(capturedCwd).toBe("/tmp/stdio-workdir");
      expect(backend.isConnected()).toBe(false);
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("AcpBackend process exit handling", () => {
  test("rejects initialize request when ACP process exits early", async () => {
    const originalSpawn = Bun.spawn;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const encoder = new TextEncoder();

    const fakeProcess = {
      stdin: {
        write: () => {
          resolveExit(255);
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("Permission denied\n"));
          controller.close();
        },
      }),
      exited,
    } as unknown as Bun.Subprocess;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((..._args: unknown[]) => {
      return fakeProcess;
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-path",
        }),
      ).rejects.toThrow("ACP process exited with code 255");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test("includes auth hint for sshpass exit code 5", async () => {
    const originalSpawn = Bun.spawn;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const fakeProcess = {
      stdin: {
        write: () => {
          resolveExit(5);
        },
      },
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited,
    } as unknown as Bun.Subprocess;

    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((..._args: unknown[]) => {
      return fakeProcess;
    }) as unknown as typeof Bun.spawn;

    const backend = new AcpBackend();
    try {
      await expect(
        backend.connect({
          mode: "spawn",
          provider: "copilot",
          transport: "ssh",
          command: "sshpass",
          args: ["-p", "secret", "ssh", "user@host", "--", "copilot", "--yolo", "--acp"],
          directory: "/workspaces/remote-path",
        }),
      ).rejects.toThrow("sshpass reported authentication failure");
    } finally {
      (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });
});

describe("AcpBackend setConfigOption", () => {
  test("throws when setConfigOption called before connect", async () => {
    const backend = new AcpBackend();
    await expect(
      backend.setConfigOption("session-1", "model", "gpt-5.2")
    ).rejects.toThrow("Not connected");
  });
});

describe("AcpBackend setSessionModel", () => {
  test("throws when setSessionModel called before connect", async () => {
    const backend = new AcpBackend();
    await expect(
      backend.setSessionModel("session-1", "anthropic/claude-sonnet-4")
    ).rejects.toThrow("Not connected");
  });
});
