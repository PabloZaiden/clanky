/**
 * Selection constraints at the controller/host boundary.
 */

import { isAgentSettings, type AgentSettings } from "@/shared/settings";
import type { HarnessAdapter } from "@/shared/settings";
import { isSupportedMeshProtocolVersion } from "@/shared/mesh-protocol";
import type { ExecutionHostRef } from "@/shared/execution-host";
import { HarnessError } from "../../backends/harness-errors";

export function assertHarnessHostPolicy(agent: AgentSettings, host: ExecutionHostRef["kind"]): void {
  if (!isAgentSettings(agent)) throw new HarnessError("harness_runtime_unavailable", "The harness configuration is invalid.");
  if (host !== "local" && host !== "mesh") {
    throw new HarnessError("harness_unsupported_feature", "A local or Mesh execution host is required.");
  }
}

export function assertHarnessMeshProtocol(adapter: HarnessAdapter, generation: number): void {
  if (adapter !== "acp" && !isSupportedMeshProtocolVersion(generation)) {
    throw new HarnessError("harness_unsupported_feature", "Native harnesses require a supported Mesh generation on the controller, worker and relay.");
  }
}
