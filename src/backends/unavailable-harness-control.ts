/**
 * Explicit ACP observability limits; unavailable never means an empty live graph.
 */

import type {
  HarnessActivitySnapshot,
  HarnessActivityStopResult,
  HarnessCapabilities,
  HarnessCleanupResult,
  HarnessControl,
  HarnessInputAdmission,
  HarnessInputRecoveryRequest,
  HarnessSteerRequest,
} from "@/shared/harness-control";
import { HarnessError } from "./harness-errors";

export class UnavailableHarnessControl implements HarnessControl {
  readonly capabilities: HarnessCapabilities = {
    adapter: "acp",
    experimental: false,
    steering: "unsupported",
    activity: "unavailable",
    stopScopes: [],
  };

  async getActivity(_sessionId: string): Promise<HarnessActivitySnapshot> {
    return { observation: "unavailable", reason: "unsupported" };
  }

  async stopActivity(_sessionId: string, _activityId: string): Promise<HarnessActivityStopResult> {
    throw new HarnessError(
      "harness_unsupported_feature",
      "This harness cannot stop an individual activity.",
    );
  }

  async steer(_sessionId: string, request: HarnessSteerRequest): Promise<HarnessInputAdmission> {
    return { status: "rejected", inputId: request.inputId, code: "unsupported" };
  }

  async reconcileInput(
    _sessionId: string,
    _request: HarnessInputRecoveryRequest,
  ): Promise<HarnessInputAdmission> {
    throw new HarnessError(
      "harness_unsupported_feature",
      "This harness cannot reconcile a steered input.",
    );
  }

  async settleOwnedWork(_sessionId: string): Promise<HarnessCleanupResult> {
    return { status: "unavailable", reason: "unsupported" };
  }
}
