import type { CreateTaskRequest } from "./api";
import type { ModelConfig } from "./task";

export type CreateTaskFormSubmitRequest = Omit<CreateTaskRequest, "model"> & {
  model?: ModelConfig;
};
