import type { CreateLoopRequest } from "./api";
import type { ModelConfig } from "./loop";

export type CreateLoopFormSubmitRequest = Omit<CreateLoopRequest, "model"> & {
  model?: ModelConfig;
};
