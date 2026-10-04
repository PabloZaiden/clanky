/**
 * Selection constraints at the controller/host boundary.
 */

import { isAgentSettings, type AgentSettings } from "@/shared/settings";
import type { HarnessAdapter } from "@/shared/settings";
import type { MeshProtocolVersion } from "@/shared/mesh-protocol";
import type { ExecutionHostRef } from "@/shared/execution-host";
import { HarnessError } from "../../backends/harness-errors";

export function assertHarnessHostPolicy(agent: AgentSettings, host: ExecutionHostRef["kind"]): void {
  if (!isAgentSettings(agent)) throw new HarnessError("harness_runtime_unavailable", "The harness configuration is invalid.");
  if (host === "ssh" && agent.adapter !== "acp") {
    throw new HarnessError("harness_unsupported_feature", "Direct SSH supports ACP only.");
  }
}

export function assertHarnessMeshProtocol(adapter: HarnessAdapter, generation: MeshProtocolVersion): void {
  if (adapter !== "acp" && generation !== 6) {
    throw new HarnessError("harness_unsupported_feature", "Native harnesses require v6 on the controller, worker and relay.");
  }
}
