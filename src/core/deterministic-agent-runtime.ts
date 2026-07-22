/**
 * Deterministic agent runtime.
 *
 * Executes user TypeScript code on the selected workspace host via Node.js 24+.
 * The TypeScript source is written to a temp directory on the host and run by
 * Node.js type stripping in an isolated child process. A JSON control protocol on the runner
 * stdout delivers ctx.stdout/stderr writes; workspace.exec runs commands on the
 * host and returns results to the program without appending them to visible output.
 * workspace.prompt bridges to Clanky's chat via the /api/internal/agent-prompt
 * route authenticated with a temporary managed API key.
 */

import type { AgentRun } from "@/shared/agent";
import type { ManagedContextIdentity } from "@/shared/context-api-key";
import { backendManager } from "./backend";
import { managedContextIdentityResolver } from "./managed-context-identity";
import {
  DETERMINISTIC_AGENT_CREDENTIAL_TTL_MS,
  DETERMINISTIC_AGENT_MANAGED_BY,
  ManagedCredentialError,
  managedCredentialService,
  type ManagedRuntimeCredential,
} from "./managed-credential-service";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";
import { DeterministicAgentOutput } from "./deterministic-agent-output";
import { assertNodeVersionOnHost, launchDeterministicAgentOnHost } from "./deterministic-agent-runner";
import { createLogger } from "@pablozaiden/webapp/server";

const log = createLogger("deterministic-agent-runtime");

async function revokeCredentialWithRetry(credential: ManagedRuntimeCredential): Promise<void> {
  try {
    await managedCredentialService.revokeCredential(credential);
  } catch (firstError) {
    try {
      await managedCredentialService.revokeCredential(credential);
    } catch (secondError) {
      throw new AggregateError(
        [firstError, secondError],
        "Failed to revoke deterministic agent runtime credential",
      );
    }
  }
}

function isOptionalCredentialUnavailable(error: unknown): error is ManagedCredentialError {
  return error instanceof ManagedCredentialError
    && error.code === "managed_context_not_configured";
}

export interface DeterministicAgentRuntimeOptions {
  run: AgentRun;
  code: string;
  chatId: string;
  workspaceId: string;
  directory: string;
  signal: AbortSignal;
  output: DeterministicAgentOutput;
  managedContextIdentity?: ManagedContextIdentity;
}

export async function executeDeterministicAgent(
  options: DeterministicAgentRuntimeOptions,
): Promise<AgentRun> {
  const { run, code, chatId, workspaceId, directory, signal, output } = options;

  const identity =
    options.managedContextIdentity ??
    (await managedContextIdentityResolver.forAgentRun(run.id, workspaceId));

  const diagnostics = validateDeterministicAgentCode(code);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  // Get the base executor (no managed env wrapping — env vars are passed explicitly).
  const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory);

  // Verify that the workspace host has a supported Node.js version.
  await assertNodeVersionOnHost(executor);

  // Create a short-lived managed API key for this run so the runner can call
  // the prompt bridge.  We use "recreate" to ensure a fresh token per run.
  let credential: ManagedRuntimeCredential | undefined;
  let executionError: unknown;
  try {
    try {
      credential = await managedCredentialService.ensureCredentialForRuntime(identity, "recreate", {
        managedBy: DETERMINISTIC_AGENT_MANAGED_BY,
        name: "Clanky deterministic agent runtime",
        scopes: ["clanky:agent-prompt"],
        expiresAt: new Date(Date.now() + DETERMINISTIC_AGENT_CREDENTIAL_TTL_MS).toISOString(),
        // Deterministic prompt calls use a temporary, prompt-only key and do
        // not depend on the workspace's general CLI-access toggle.
        allowWhenWorkspaceDisabled: true,
      });
    } catch (error) {
      if (!isOptionalCredentialUnavailable(error)) {
        throw error;
      }
      log.debug("Deterministic prompt bridge credentials are not configured", {
        runId: run.id,
        reason: error.code,
      });
    }
    if (signal.aborted) {
      throw Object.assign(
        new Error("Deterministic agent run interrupted"),
        { cause: "aborted" },
      );
    }

    return await launchDeterministicAgentOnHost({
      run,
      sourceCode: code,
      chatId,
      credential,
      directory,
      signal,
      output,
      executor,
    });
  } catch (error) {
    executionError = error;
    throw error;
  } finally {
    if (credential) {
      try {
        await revokeCredentialWithRetry(credential);
      } catch (revokeError) {
        log.error("Failed to revoke deterministic agent runtime credential", {
          runId: run.id,
          error: String(revokeError),
        });
        if (executionError !== undefined) {
          throw new AggregateError(
            [executionError, revokeError],
            "Deterministic agent execution and credential cleanup failed",
          );
        }
        throw revokeError;
      }
    }
  }
}
