/**
 * Transport-neutral prerequisite and Devbox discovery for execution hosts.
 */

import type {
  DevboxTemplateSummary,
  ExecutionHostRef,
  SshServerPrerequisiteReport,
} from "@/shared";
import { serializeExecutionHostRef } from "@/shared/execution-host";
import { parseDevboxTemplatesOutput } from "./ssh-server-devbox-templates";
import {
  executionHostService,
  type ExecutionHostCommandContext,
} from "./execution-host-service";
import { checkExecutionHostPrerequisites } from "./ssh-server-prerequisites";
import { DomainError } from "./domain-error";

export interface ExecutionHostDiscoveryContext extends ExecutionHostCommandContext {
  repositoriesBasePath: string | null;
  responseId?: string;
}

function transportLabel(ref: ExecutionHostRef): string {
  if (ref.kind === "ssh") {
    return "SSH";
  }
  if (ref.kind === "mesh") {
    return "Mesh";
  }
  return "local";
}

export class ExecutionHostDiscoveryService {
  async checkPrerequisites(
    ref: ExecutionHostRef,
    context: ExecutionHostDiscoveryContext,
  ): Promise<SshServerPrerequisiteReport> {
    const executor = await executionHostService.getCommandExecutorForRef(ref, context);
    return await checkExecutionHostPrerequisites({
      targetId: context.responseId ?? serializeExecutionHostRef(ref),
      connectionLabel: transportLabel(ref),
      repositoriesBasePath: context.repositoriesBasePath,
    }, executor);
  }

  async listDevboxTemplates(
    ref: ExecutionHostRef,
    context: ExecutionHostCommandContext,
  ): Promise<DevboxTemplateSummary[]> {
    const executor = await executionHostService.getCommandExecutorForRef(ref, context);
    const result = await executor.exec("devbox", ["templates"], { cwd: "/" });
    if (!result.success) {
      throw new DomainError(
        "execution_host_templates_failed",
        "Failed to list Devbox templates on the execution host.",
        {
          details: {
            executionHost: serializeExecutionHostRef(ref),
            exitCode: result.exitCode,
          },
        },
      );
    }
    return parseDevboxTemplatesOutput(result.stdout);
  }
}

export const executionHostDiscoveryService = new ExecutionHostDiscoveryService();
