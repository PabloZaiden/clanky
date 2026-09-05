/**
 * Updates node-owned execution defaults without coupling transport adapters.
 */

import type {
  ExecutionHostDescriptor,
  ExecutionHostModelConfig,
  ExecutionHostRef,
} from "@/shared/execution-host";
import { executionHostRefsEqual } from "@/shared/execution-host";
import { setLocalMeshExecutionConfiguration } from "../persistence/mesh-node-identity";
import { DomainError } from "./domain-error";
import { executionHostService } from "./execution-host-service";
import { requireCurrentUserId } from "./user-context";

export class ExecutionHostConfigurationService {
  async updateNodeDefaults(
    ref: ExecutionHostRef,
    input: {
      repositoriesBasePath: string | null;
      preferredModel: ExecutionHostModelConfig | null;
      expectedRevision: number;
    },
    userId: string = requireCurrentUserId(),
  ): Promise<ExecutionHostDescriptor> {
    if (ref.kind !== "local") {
      throw new DomainError(
        "execution_host_configuration_unsupported",
        ref.kind === "mesh"
          ? "Mesh worker defaults are owned by the worker and cannot be changed remotely."
          : "SSH server defaults must be changed through SSH server settings.",
      );
    }

    const current = (await executionHostService.listHosts(userId))
      .find((candidate) => executionHostRefsEqual(candidate.ref, ref));
    if (!current) {
      throw new DomainError(
        "execution_host_unavailable",
        "The selected execution host is unavailable.",
      );
    }
    const repositoriesBasePath = input.repositoriesBasePath?.trim() || null;
    if (repositoriesBasePath) {
      await executionHostService.assertDirectoryExists(ref, repositoriesBasePath, {
        userId,
      });
    }

    await setLocalMeshExecutionConfiguration({
      acceptRemoteExecution: true,
      repositoriesBasePath,
      preferredModel: input.preferredModel,
    }, input.expectedRevision);
    const updated = (await executionHostService.listHosts(userId))
      .find((candidate) => executionHostRefsEqual(candidate.ref, ref));
    if (!updated) {
      throw new DomainError(
        "execution_host_unavailable",
        "The updated execution host is unavailable.",
      );
    }
    return updated;
  }
}

export const executionHostConfigurationService =
  new ExecutionHostConfigurationService();
