/**
 * Native catalog pagination and reasoning-effort validation.
 */

import type { ModelInfo } from "@/contracts";
import type { ReasoningEffort } from "./generated/ReasoningEffort";
import type { Model } from "./generated/v2/Model";
import type { CodexRpcSession } from "./rpc-session";
import { HarnessError } from "../harness-errors";

export class CodexModelCatalog {
  constructor(private readonly rpc: CodexRpcSession) {}

  async list(): Promise<Model[]> {
    const models: Model[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await this.rpc.request("model/list", { cursor, limit: 50, includeHidden: false });
      models.push(...result.data);
      if (!result.nextCursor) return models;
      cursor = result.nextCursor;
    }
    throw new HarnessError("harness_request_failed", "The native model catalog exceeded its pagination limit.");
  }

  async getModels(): Promise<ModelInfo[]> {
    return (await this.list()).map((model) => ({
      providerID: "codex",
      providerName: "Codex",
      modelID: model.model,
      modelName: model.displayName,
      connected: true,
      variants: ["", ...model.supportedReasoningEfforts.map((option) => option.reasoningEffort)],
    }));
  }

  async requireModel(modelID: string, variant?: string): Promise<{ model: Model; effort?: ReasoningEffort }> {
    const model = (await this.list()).find((entry) => entry.model === modelID);
    if (!model) throw new HarnessError("harness_model_not_available", "The native Codex model is unavailable.");
    const effort = variant ? model.supportedReasoningEfforts.find((entry) => entry.reasoningEffort === variant)?.reasoningEffort : undefined;
    if (variant && !effort) throw new HarnessError("harness_invalid_model_option", "The native Codex effort is unavailable.");
    return { model, effort };
  }
}
