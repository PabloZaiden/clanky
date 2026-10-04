/**
 * Native Copilot catalog and option validation without temporary conversations.
 */

import type { ModelInfo as CopilotModelInfo } from "@github/copilot-sdk";
import type { ModelInfo } from "@/contracts";
import { HarnessError } from "../harness-errors";
import type { CopilotRuntime } from "./runtime";

export class CopilotModelCatalog {
  constructor(private readonly runtime: CopilotRuntime) {}

  async getModels(): Promise<ModelInfo[]> {
    await this.runtime.client.ping();
    const models = await this.runtime.client.listModels();
    return models.map((model) => ({
      providerID: "copilot",
      providerName: "GitHub Copilot",
      modelID: model.id,
      modelName: model.name,
      connected: this.runtime.isOpen() && (!model.policy || model.policy.state === "enabled"),
      variants: model.supportedReasoningEfforts ? ["", ...model.supportedReasoningEfforts] : [],
    }));
  }

  async requireModel(
    modelID: string,
    variant?: string,
  ): Promise<{
    model: CopilotModelInfo;
    reasoningEffort?: NonNullable<CopilotModelInfo["supportedReasoningEfforts"]>[number];
  }> {
    await this.runtime.client.ping();
    const model = (await this.runtime.client.listModels()).find((entry) => entry.id === modelID);
    if (!model || (model.policy && model.policy.state !== "enabled")) {
      throw new HarnessError("harness_model_not_available", "The selected Copilot model is unavailable.", {
        details: { modelID },
      });
    }
    if (!variant) return { model };
    const reasoningEffort = model.supportedReasoningEfforts?.find((effort) => effort === variant);
    if (!reasoningEffort) {
      throw new HarnessError("harness_invalid_model_option", "The selected Copilot reasoning effort is unavailable.", {
        details: { modelID, variant },
      });
    }
    return { model, reasoningEffort };
  }
}
