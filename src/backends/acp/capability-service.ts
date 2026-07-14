/**
 * Capability, model discovery, and provider adaptation service.
 *
 * Owns config-option parsing, model extraction from config/legacy response
 * shapes, model and reasoning-effort caches, variant discovery, temporary
 * discovery-session cleanup, provider labels, and provider capability checks.
 * Provider-specific behavior lives behind a narrow capability table rather than
 * being scattered through transport or session code. Optional discovery methods
 * flow through the typed optional-method helper so real failures propagate.
 */

import { log } from "../../core/logger";
import { AGENT_PROVIDER_OPTIONS } from "../../constants/agent-providers";
import type { AgentProvider } from "@/shared/settings";
import type { ModelInfo } from "@/contracts";
import type { ConfigOption } from "../types";

import { isRecord, getString } from "./json-helpers";
import { getAcpErrorMessage } from "./errors";
import { invokeOptionalMethod } from "./optional-method";
import type { RpcRequester, ConfigOptionSetter } from "./contracts";

type CachedModels = {
  models: ModelInfo[];
  complete: boolean;
};

/** Providers that expose reasoning-effort variants via config options. */
const VARIANT_DISCOVERY_PROVIDERS: ReadonlySet<AgentProvider> = new Set<AgentProvider>([
  "copilot",
  "opencode",
  "codex",
]);

export class CapabilityService {
  private provider: AgentProvider | null = null;

  private readonly modelCache = new Map<string, CachedModels>();
  private readonly defaultReasoningEfforts = new Map<string, Map<string, string>>();

  constructor(private readonly rpc: RpcRequester) {}

  setProvider(provider: AgentProvider | null): void {
    this.provider = provider;
  }

  clearCaches(): void {
    this.modelCache.clear();
    this.defaultReasoningEfforts.clear();
  }

  // ---- Config option parsing ----

  parseConfigOptions(result: unknown): ConfigOption[] {
    if (!isRecord(result)) {
      return [];
    }

    const rawOptions = result["configOptions"];
    if (!Array.isArray(rawOptions)) {
      return [];
    }

    const parsed: ConfigOption[] = [];
    for (const item of rawOptions) {
      if (!isRecord(item)) {
        continue;
      }

      const id = getString(item["id"]);
      const name = getString(item["name"]);
      const type = getString(item["type"]);
      const currentValue = getString(item["currentValue"]);
      if (!id || !name || !type || !currentValue) {
        continue;
      }

      const rawValues = Array.isArray(item["options"]) ? item["options"] : [];
      const options = rawValues
        .filter((v): v is Record<string, unknown> => isRecord(v))
        .filter((v) => getString(v["value"]) && getString(v["name"]))
        .map((v) => ({
          value: getString(v["value"])!,
          name: getString(v["name"])!,
          ...(getString(v["description"]) ? { description: getString(v["description"])! } : {}),
        }));

      parsed.push({
        id,
        name,
        type,
        currentValue,
        options,
        ...(getString(item["description"]) ? { description: getString(item["description"])! } : {}),
        ...(getString(item["category"]) ? { category: getString(item["category"])! } : {}),
      });
    }

    return parsed;
  }

  getModelConfigOption(configOptions: ConfigOption[]): ConfigOption | undefined {
    return configOptions.find((option) => option.category === "model" || option.id === "model");
  }

  getReasoningEffortConfigOption(configOptions: ConfigOption[]): ConfigOption | undefined {
    return configOptions.find((option) =>
      option.id === "reasoning_effort"
      || option.category === "thought_level"
      || option.category === "reasoning_effort"
      || option.category === "effort"
    );
  }

  // ---- Reasoning effort defaults ----

  rememberDefaultReasoningEffort(
    directory: string,
    modelID: string | undefined,
    configOptions: ConfigOption[],
  ): void {
    if (!modelID) {
      return;
    }
    const reasoningOption = this.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption?.currentValue) {
      return;
    }
    const existing = this.defaultReasoningEfforts.get(directory) ?? new Map<string, string>();
    existing.set(modelID, reasoningOption.currentValue);
    this.defaultReasoningEfforts.set(directory, existing);
  }

  getDefaultReasoningEffort(directory: string, modelID: string): string | undefined {
    return this.defaultReasoningEfforts.get(directory)?.get(modelID);
  }

  buildReasoningEffortVariants(configOptions: ConfigOption[]): string[] {
    const reasoningOption = this.getReasoningEffortConfigOption(configOptions);
    if (!reasoningOption) {
      return [""];
    }

    const values = reasoningOption.options
      .map((option) => option.value)
      .filter((value) => value.length > 0);
    if (values.length === 0) {
      return [""];
    }

    const variants: string[] = [];
    if (reasoningOption.currentValue && values.includes(reasoningOption.currentValue)) {
      variants.push(reasoningOption.currentValue);
    }
    for (const value of values) {
      if (!variants.includes(value)) {
        variants.push(value);
      }
    }
    return variants;
  }

  // ---- Model caches ----

  getCachedModels(directory: string): CachedModels | undefined {
    return this.modelCache.get(directory);
  }

  hasCachedModels(directory: string): boolean {
    return !!this.getCachedModels(directory);
  }

  supportsConfigOptionVariantDiscovery(): boolean {
    return this.provider !== null && VARIANT_DISCOVERY_PROVIDERS.has(this.provider);
  }

  shouldTreatCachedModelsAsComplete(): boolean {
    return !this.supportsConfigOptionVariantDiscovery();
  }

  setCachedModels(directory: string, models: ModelInfo[], complete: boolean): void {
    if (models.length === 0) {
      return;
    }
    const existing = this.getCachedModels(directory);
    if (existing?.complete && !complete) {
      return;
    }
    this.modelCache.set(directory, { models, complete });
  }

  // ---- Provider naming ----

  getDiscoveredModelProviderID(providerID?: string): string {
    if (this.provider) {
      return this.provider;
    }
    return providerID ?? "unknown";
  }

  getDiscoveredModelProviderName(providerID: string): string {
    return AGENT_PROVIDER_OPTIONS.find((option) => option.id === providerID)?.label ?? providerID;
  }

  // ---- Model extraction ----

  parseModelsFromSessionResult(result: unknown): ModelInfo[] {
    if (!isRecord(result)) {
      return [];
    }

    const modelsRaw = result["models"];
    const modelEntries = Array.isArray(modelsRaw)
      ? modelsRaw
      : isRecord(modelsRaw) && Array.isArray(modelsRaw["availableModels"])
        ? modelsRaw["availableModels"]
        : [];

    const mapped: ModelInfo[] = [];
    for (const item of modelEntries) {
      if (!isRecord(item)) {
        continue;
      }

      const modelID = getString(item["id"]) ?? getString(item["modelId"]);
      if (!modelID) {
        continue;
      }

      const name = getString(item["name"]) ?? modelID;
      const providerID = this.getDiscoveredModelProviderID(getString(item["provider"]));

      mapped.push({
        providerID,
        providerName: this.getDiscoveredModelProviderName(providerID),
        modelID,
        modelName: name,
        connected: true,
        variants: [""],
      });
    }

    const seen = new Set<string>();
    return mapped.filter((model) => {
      const key = `${model.providerID}:${model.modelID}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  parseModelsFromConfigOptions(configOptions: ConfigOption[]): ModelInfo[] {
    const modelOption = this.getModelConfigOption(configOptions);
    if (!modelOption) {
      return [];
    }

    return modelOption.options.map((opt) => {
      const providerID = this.getDiscoveredModelProviderID();
      return {
        providerID,
        providerName: this.getDiscoveredModelProviderName(providerID),
        modelID: opt.value,
        modelName: opt.name,
        connected: true,
      };
    });
  }

  // ---- Discovery orchestration ----

  async getModels(directory: string): Promise<ModelInfo[]> {
    const cached = this.getCachedModels(directory);
    if (cached) {
      return cached.models;
    }

    const result = await this.rpc.sendRequest<unknown>("session/new", {
      cwd: directory,
      mcpServers: [],
    });
    const sessionId = isRecord(result) ? getString(result["sessionId"]) : undefined;

    try {
      const configOptions = this.parseConfigOptions(result);
      const configModels = this.parseModelsFromConfigOptions(configOptions);
      if (configModels.length > 0) {
        this.setCachedModels(directory, configModels, true);
        return configModels;
      }

      const models = this.parseModelsFromSessionResult(result);
      if (models.length > 0) {
        this.setCachedModels(directory, models, true);
        return models;
      }
      return [];
    } finally {
      if (sessionId) {
        await this.cleanupDiscoverySession(sessionId);
      }
    }
  }

  async getModelVariants(
    directory: string,
    modelID: string,
    setConfigOption: ConfigOptionSetter,
  ): Promise<string[]> {
    const result = await this.rpc.sendRequest<unknown>("session/new", {
      cwd: directory,
      mcpServers: [],
    });
    const sessionId = isRecord(result) ? getString(result["sessionId"]) : undefined;

    try {
      const configOptions = this.parseConfigOptions(result);
      if (!this.supportsConfigOptionVariantDiscovery() || !sessionId || configOptions.length === 0) {
        return [""];
      }

      return await this.discoverModelVariantsForConfigOptions(
        directory,
        sessionId,
        configOptions,
        modelID,
        setConfigOption,
      );
    } finally {
      if (sessionId) {
        await this.cleanupDiscoverySession(sessionId);
      }
    }
  }

  private async discoverModelVariantsForConfigOptions(
    directory: string,
    sessionId: string,
    initialConfigOptions: ConfigOption[],
    modelID: string,
    setConfigOption: ConfigOptionSetter,
  ): Promise<string[]> {
    const modelOption = this.getModelConfigOption(initialConfigOptions);
    if (!modelOption?.options.some((option) => option.value === modelID)) {
      return [""];
    }

    let configOptions = initialConfigOptions;
    const currentModelOption = this.getModelConfigOption(configOptions);
    if (currentModelOption?.currentValue !== modelID) {
      configOptions = await setConfigOption(sessionId, currentModelOption?.id ?? "model", modelID);
    }

    this.rememberDefaultReasoningEffort(directory, modelID, configOptions);
    return this.buildReasoningEffortVariants(configOptions);
  }

  private async cleanupDiscoverySession(sessionId: string): Promise<void> {
    try {
      const outcome = await invokeOptionalMethod(this.rpc, "session/delete", { sessionId }, 5_000);
      if (outcome.kind === "method-not-found") {
        log.debug("[AcpBackend] Temporary discovery session deletion is not supported", {
          sessionId,
        });
      }
    } catch (error) {
      log.warn("[AcpBackend] Failed to delete temporary discovery session", {
        sessionId,
        error: getAcpErrorMessage(error),
      });
    }
  }
}
