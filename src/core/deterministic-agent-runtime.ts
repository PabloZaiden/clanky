/**
 * Deterministic agent runtime.
 *
 * Executes user TypeScript code on the selected workspace host via Node.js 24+.
 * The TypeScript source is written to a temp directory on the host and run by
 * Node.js type stripping in an isolated child process. A JSON control protocol on the runner
 * stdout delivers ctx.stdout/stderr writes; workspace.exec runs commands on the
 * host and returns results to the program without appending them to visible output.
 * The controller admits typed control and current-conversation prompt requests
 * using this execution's authority. No API credentials are sent to the host.
 */

import type { AgentRun } from "@/shared/agent";
import type { ManagedContextIdentity } from "@/shared/context-api-key";
import { backendManager } from "./backend";
import { managedContextIdentityResolver } from "./managed-context-identity";
import { createExecutionControlConnection } from "./control-tool-transport";
import { validateDeterministicAgentCode } from "./deterministic-agent-code";
import { DeterministicAgentOutput } from "./deterministic-agent-output";
import { assertNodeVersionOnHost, launchDeterministicAgentOnHost } from "./deterministic-agent-runner";

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

  const executor = await backendManager.getCommandExecutorAsync(workspaceId, directory);
  await assertNodeVersionOnHost(executor);
  const control = await createExecutionControlConnection(identity);
  if (signal.aborted) throw new Error("Deterministic agent run interrupted", { cause: "aborted" });
  return await launchDeterministicAgentOnHost({
    run, sourceCode: code, chatId, control, directory, signal, output, executor,
  });
}
