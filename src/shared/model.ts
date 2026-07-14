/**
 * Browser/server-safe model domain types.
 *
 * Runtime validation for these types belongs in `src/contracts/schemas/model.ts`.
 *
 * @module shared/model
 */

export interface ModelConfig {
  providerID: string;
  modelID: string;
  variant: string;
}

export type CheapModelSelection =
  | {
      mode: "same-as-task";
    }
  | {
      mode: "custom";
      model: ModelConfig;
    };
