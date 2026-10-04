/**
 * Waits for provider activation before querying native model/variant metadata.
 */

import type { OpenCodeClient, ModelInfo as NativeModel } from "@opencode/client";
import type { ModelInfo } from "@/contracts";
import { HarnessError } from "../harness-errors";

export class OpenCodeModelCatalog {
  constructor(private readonly dependencies: { client: OpenCodeClient; directory: string }) {}

  async list(): Promise<NativeModel[]> {
    const location = { directory: this.dependencies.directory };
    await this.dependencies.client.integration.list({ location });
    return (await this.dependencies.client.model.list({ location })).data;
  }
  async getModels(): Promise<ModelInfo[]> {
    return (await this.list()).map((model) => ({
      providerID: model.providerID, providerName: model.providerID,
      modelID: model.id, modelName: model.name, connected: model.enabled,
      variants: ["", ...model.variants.map((variant) => variant.id)],
    }));
  }
  async requireModel(id: string, variant?: string, providerID?: string): Promise<NativeModel> {
    const model = (await this.list()).find((entry) => entry.id === id && (!providerID || entry.providerID === providerID));
    if (!model?.enabled) throw new HarnessError("harness_model_not_available", "The native OpenCode model is unavailable.");
    if (variant && !model.variants.some((entry) => entry.id === variant)) throw new HarnessError("harness_invalid_model_option", "The native OpenCode variant is unavailable.");
    return model;
  }
}
