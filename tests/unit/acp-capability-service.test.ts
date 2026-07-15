import { describe, expect, test } from "bun:test";
import { CapabilityService } from "../../src/backends/acp/capability-service";
import type { JsonRpcMessage } from "../../src/backends/acp/types";
import type { RpcRequester } from "../../src/backends/acp/contracts";
import type { ConfigOption } from "../../src/backends/types";
import { AcpError } from "../../src/backends/acp/errors";

function createRequester(
  handler: (method: string, params: Record<string, unknown>) => unknown,
): { requester: RpcRequester; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const requester: RpcRequester = {
    async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
      calls.push({ method, params });
      return handler(method, params) as T;
    },
    writeMessage(_message: JsonRpcMessage): void {},
  };
  return { requester, calls };
}

const modelConfigOptions = [
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5" },
      { value: "claude", name: "Claude" },
    ],
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    type: "select",
    category: "thought_level",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

describe("CapabilityService", () => {
  test("parses config options and extracts models with provider labels", () => {
    const { requester } = createRequester(() => ({}));
    const capability = new CapabilityService(requester);
    capability.setProvider("copilot");

    const parsed = capability.parseConfigOptions({ configOptions: modelConfigOptions });
    expect(parsed).toHaveLength(2);

    const models = capability.parseModelsFromConfigOptions(parsed);
    expect(models.map((m) => m.modelID)).toEqual(["gpt-5", "claude"]);
    expect(models[0]!.providerID).toBe("copilot");
  });

  test("discovers models via session/new and cleans up the discovery session", async () => {
    const { requester, calls } = createRequester((method) => {
      if (method === "session/new") {
        return { sessionId: "disco-1", configOptions: modelConfigOptions };
      }
      return {};
    });
    const capability = new CapabilityService(requester);
    capability.setProvider("copilot");

    const models = await capability.getModels("/repo");
    expect(models.map((m) => m.modelID)).toEqual(["gpt-5", "claude"]);
    expect(calls.map((c) => c.method)).toEqual(["session/new", "session/delete"]);

    // Second call is served from cache (no additional session/new).
    const cached = await capability.getModels("/repo");
    expect(cached.map((m) => m.modelID)).toEqual(["gpt-5", "claude"]);
    expect(calls.filter((c) => c.method === "session/new")).toHaveLength(1);
  });

  test("builds reasoning-effort variants ordered by current value first", async () => {
    const { requester } = createRequester((method) => {
      if (method === "session/new") {
        return { sessionId: "disco-2", configOptions: modelConfigOptions };
      }
      if (method === "session/set_config_option") {
        return { configOptions: modelConfigOptions };
      }
      return {};
    });
    const capability = new CapabilityService(requester);
    capability.setProvider("copilot");

    const setConfigOption = async (): Promise<ConfigOption[]> =>
      capability.parseConfigOptions({ configOptions: modelConfigOptions });

    const variants = await capability.getModelVariants("/repo", "gpt-5", setConfigOption);
    expect(variants).toEqual(["medium", "low", "high"]);
  });

  test("returns a single default variant for providers without variant discovery", async () => {
    const { requester } = createRequester((method) => {
      if (method === "session/new") {
        return { sessionId: "disco-3", configOptions: modelConfigOptions };
      }
      return {};
    });
    const capability = new CapabilityService(requester);
    capability.setProvider("claude");

    const setConfigOption = async (): Promise<ConfigOption[]> => [];
    const variants = await capability.getModelVariants("/repo", "gpt-5", setConfigOption);
    expect(variants).toEqual([""]);
  });

  test("keeps a complete cache from being overwritten by an incomplete result", () => {
    const { requester } = createRequester(() => ({}));
    const capability = new CapabilityService(requester);
    capability.setProvider("copilot");

    const models = [
      { providerID: "copilot", providerName: "Copilot", modelID: "gpt-5", modelName: "GPT-5", connected: true },
    ];
    capability.setCachedModels("/repo", models, true);
    capability.setCachedModels("/repo", [
      { providerID: "copilot", providerName: "Copilot", modelID: "other", modelName: "Other", connected: true },
    ], false);

    expect(capability.getCachedModels("/repo")?.models.map((m) => m.modelID)).toEqual(["gpt-5"]);
  });

  test("keeps discovery results when best-effort cleanup fails", async () => {
    const { requester } = createRequester((method) => {
      if (method === "session/new") {
        return {
          sessionId: "disco-cleanup-failure",
          configOptions: [
            {
              id: "model",
              name: "Model",
              type: "select",
              category: "model",
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
          ],
        };
      }
      throw new AcpError("acp_request_timed_out", "cleanup timed out");
    });
    const capability = new CapabilityService(requester);
    capability.setProvider("copilot");

    await expect(capability.getModels("/repo")).resolves.toMatchObject([
      { modelID: "gpt-5", providerID: "copilot" },
    ]);
  });
});
