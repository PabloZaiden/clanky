import { z } from "zod";
import { DomainError } from "../../domain/domain-error";
import { closeCommandExecutor, type CommandExecutor } from "../command-executor";
import { meshManager } from "../mesh-manager";

export const WORKER_RESTART_TIMEOUT_MS = 20_000;
const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_PROBE_TIMEOUT_MS = 5000;
const WorkerServiceStatusSchema = z.object({
  installed: z.boolean(),
  running: z.boolean(),
  binaryVersion: z.string().optional(),
  instanceId: z.string().optional(),
  runningVersion: z.string().optional(),
  releaseChannel: z.enum(["stable", "latest", "prerelease"]).optional(),
});

export type WorkerServiceStatus = z.infer<typeof WorkerServiceStatusSchema>;

function isWorkerRestartConnectionLoss(error: unknown): boolean {
  return error instanceof DomainError && (
    error.code === "mesh_execution_unreachable"
    || error.code === "mesh_execution_session_invalid"
    || error.code === "mesh_execution_session_expired"
    || error.code === "mesh_execution_async_command_not_found"
    || ((error.code === "mesh_execution_request_failed")
      && [502, 503, 504].includes(Number(error.details["status"])))
  );
}

export function isWorkerRestartResponseLoss(error: unknown): boolean {
  return error instanceof DomainError
    && error.details["executionRequestDispatched"] === true
    && error.details["executionResultReceived"] !== true
    && (isWorkerRestartConnectionLoss(error)
      || error.code === "mesh_execution_aborted"
      || error.code === "mesh_execution_response_invalid"
      || error.code === "mesh_execution_output_gap");
}

function isRecoverableProbeFailure(error: unknown): boolean {
  return isWorkerRestartConnectionLoss(error)
    || (error instanceof DomainError && (
      error.code === "mesh_control_request_unreachable"
      || error.code === "mesh_control_response_unreachable"
      || error.code === "worker_service_not_running"
      || error.code === "worker_restart_not_observed"
      || error.code === "worker_restart_version_mismatch"
      || error.code === "worker_restart_channel_mismatch"
      || ((error.code === "mesh_control_request_rejected"
        || error.code === "mesh_execution_request_failed")
        && [502, 503, 504].includes(Number(error.details["status"])))
    ));
}

export async function readWorkerServiceStatus(
  executor: CommandExecutor,
  signal?: AbortSignal,
): Promise<WorkerServiceStatus> {
  const result = await executor.exec("clanky", ["worker", "service", "status"], {
    signal,
    timeout: RESTART_PROBE_TIMEOUT_MS,
    maxOutputBytes: 16 * 1024,
    logFailures: false,
  });
  if (!result.success) {
    throw new DomainError(
      "worker_service_status_failed",
      `Could not inspect the worker service or workspace loop (exit code ${String(result.exitCode)}). Ensure its service is installed; older automatic workspaces need their launcher upgraded manually.`,
      { details: { exitCode: result.exitCode } },
    );
  }
  let status: unknown;
  try {
    status = JSON.parse(result.stdout);
  } catch (error) {
    throw new DomainError(
      "worker_service_status_invalid",
      "The worker service status is not valid JSON.",
      { cause: error },
    );
  }
  const parsed = WorkerServiceStatusSchema.safeParse(status);
  if (!parsed.success) {
    throw new DomainError(
      "worker_service_status_invalid",
      "The worker service status must report whether it is installed and running.",
    );
  }
  return parsed.data;
}

function requireRunningWorker(status: WorkerServiceStatus): void {
  if (!status.installed || !status.running) {
    throw new DomainError(
      "worker_service_not_running",
      "The worker service is not installed and running yet.",
    );
  }
}

export async function confirmWorkerRestart({
  userId,
  workerNodeId,
  deadline,
  previousInstanceId,
  expectedVersion,
  expectedChannel,
  createExecutor,
  onRetry,
}: {
  userId: string;
  workerNodeId: string;
  deadline: number;
  previousInstanceId?: string;
  expectedVersion?: string;
  expectedChannel?: "stable" | "latest";
  createExecutor: () => Promise<CommandExecutor>;
  onRetry: (error: unknown) => void;
}): Promise<void> {
  let lastError: unknown;
  while (performance.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(RESTART_PROBE_TIMEOUT_MS, deadline - performance.now()),
    );
    let executor: CommandExecutor | undefined;
    try {
      await meshManager.checkWorkerReachability(userId, workerNodeId, {
        signal: controller.signal,
      });
      executor = await createExecutor();
      const status = await readWorkerServiceStatus(executor, controller.signal);
      requireRunningWorker(status);
      if (previousInstanceId && (!status.instanceId || status.instanceId === previousInstanceId)) {
        throw new DomainError("worker_restart_not_observed", "The previous worker instance is still running.");
      }
      if (expectedVersion && status.runningVersion !== expectedVersion) {
        throw new DomainError("worker_restart_version_mismatch", "The worker has not started the updated binary yet.");
      }
      if (expectedChannel && status.releaseChannel !== expectedChannel) {
        throw new DomainError("worker_restart_channel_mismatch", "The worker has not restored the selected release channel yet.");
      }
      if (performance.now() < deadline) return;
    } catch (error) {
      if (!controller.signal.aborted && !isRecoverableProbeFailure(error)) {
        throw error;
      }
      lastError = error;
      onRetry(error);
    } finally {
      clearTimeout(timer);
      if (executor) closeCommandExecutor(executor);
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await Bun.sleep(Math.min(RESTART_POLL_INTERVAL_MS, remaining));
  }
  throw new DomainError(
    "worker_restart_confirmation_timeout",
    "The worker did not return with an installed, running service within 20 seconds."
      + (lastError instanceof Error ? ` Last check: ${lastError.message}` : ""),
    { cause: lastError },
  );
}
