import { posix as pathPosix } from "node:path";
import { backendManager } from "../backend-manager";
import type { CommandExecutor } from "../command-executor";
import { GitService } from "../git";
import { createLogger } from "@pablozaiden/webapp/server";
import {
  getWorkspace,
} from "../../persistence/workspaces";
import {
  createProvisioningJob,
  dismissProvisioningJob,
  listProvisioningJobs,
  loadProvisioningJob,
  markProvisioningJobsInterrupted,
  updateProvisioningJob,
} from "../../persistence/provisioning-jobs";
import { workspaceManager } from "../workspace-manager";
import type {
  ExecutionHostBinding,
  ProvisioningJob,
  ProvisioningJobSnapshot,
  ProvisioningLogEntry,
  ProvisioningStep,
  ProvisioningTransport,
  ServerSettings,
  DevboxStatusResult,
} from "@/shared";
import { isValidWorkerHostAddress } from "@/shared";
import { getRegisteredSshServerId, isWorkspaceSshExecutionHostRef } from "@/shared/execution-host";
import {
  DEFAULT_MAX_LOG_ENTRIES,
  DEVBOX_UP_TIMEOUT_MS,
  GIT_CLONE_TIMEOUT_MS,
  WORKER_READINESS_POLL_INTERVAL_MS,
  WORKER_READINESS_TIMEOUT_MS,
} from "./constants";
import {
  buildError,
  getSinglePublishedPort,
  parseDevboxCredentialContent,
  parseDevboxStatusOutput,
} from "./devbox-utils";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { emitJobCancelled, emitJobCompleted, emitJobDismissed, emitJobFailed, emitJobStarted } from "./job-events";
import { appendSystemLog, setStep } from "./job-logger";
import { runProvisioningCommand } from "./command-runner";
import { extractRepoName, normalizeRepoUrl } from "./repo-utils";
import type { ProvisioningJobRecord, StartProvisioningJobOptions } from "./types";
import { requireCurrentUser, requireCurrentUserId, runWithCurrentUser } from "../user-context";
import { executionHostService } from "../execution-host-service";
import { executionHostDiscoveryService } from "../execution-host-discovery-service";
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import { meshManager } from "../mesh-manager";
import { getSshServerConfig } from "../../persistence/ssh-servers";
import type { WorkspaceSshTargetInput } from "../../persistence/workspace-execution-targets";

const log = createLogger("core:provisioning-manager");

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateWorkerHostAddress(value: string | undefined): string {
  const address = value?.trim() ?? "";
  if (!isValidWorkerHostAddress(address)) {
    throw new ProvisioningFailedError(
      "invalid_worker_host_address",
      "devbox_status",
      "A valid worker host address without spaces is required for worker provisioning.",
    );
  }
  return address;
}

function createDeadlineSignal(
  parentSignal: AbortSignal,
  deadlineAt: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(0, deadlineAt - Date.now()),
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", abortFromParent);
    },
  };
}

async function waitForReadinessPoll(
  signal: AbortSignal,
  delayMs: number,
): Promise<void> {
  if (delayMs <= 0 || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => finish();
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface WorkerPaths {
  hostRoot: string;
  containerRoot: string;
  containerBinary: string;
  containerData: string;
  containerLauncher: string;
  containerLog: string;
  containerPid: string;
}

function getWorkerPaths(
  targetDirectory: string,
  containerWorkdir: string,
): WorkerPaths {
  const hostRoot = pathPosix.join(targetDirectory, ".devbox", "clanky-worker");
  const containerRoot = pathPosix.join(containerWorkdir, ".devbox", "clanky-worker");
  return {
    hostRoot,
    containerRoot,
    containerBinary: pathPosix.join(containerRoot, "bin", "clanky"),
    containerData: pathPosix.join(containerRoot, "data"),
    containerLauncher: pathPosix.join(containerRoot, "launcher.sh"),
    containerLog: pathPosix.join(containerRoot, "worker.log"),
    containerPid: pathPosix.join(containerRoot, "worker.pid"),
  };
}

function buildWorkerLauncher(paths: WorkerPaths): string {
  return `#!/bin/sh
set -eu

bin_dir=${shellQuote(pathPosix.join(paths.containerRoot, "bin"))}
data_dir=${shellQuote(paths.containerData)}
binary=${shellQuote(paths.containerBinary)}
installer=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".installer.sh"))}
install_dir=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".install"))}
install_home=${shellQuote(pathPosix.join(paths.containerRoot, "bin", ".install-home"))}
installed_binary="$install_home/.local/bin/clanky"
log_file=${shellQuote(paths.containerLog)}
pid_file=${shellQuote(paths.containerPid)}

mkdir -p "$bin_dir" "$data_dir" "$install_dir" "$install_home"
curl -fsSL https://raw.githubusercontent.com/pablozaiden/installer/main/install.sh -o "$installer"
HOME="$install_home" sh "$installer" pablozaiden/clanky --install-dir "$install_dir"
if [ -x "$install_dir/clanky" ]; then
  source_binary="$install_dir/clanky"
elif [ -x "$installed_binary" ]; then
  source_binary="$installed_binary"
else
  echo "The Clanky installer did not produce an executable binary." >&2
  exit 1
fi
mv -f "$source_binary" "$binary"
rm -rf "$install_dir" "$install_home"
rm -f "$installer"

if [ ! -f "$data_dir/config.json" ]; then
  exit 0
fi

if [ -s "$pid_file" ]; then
  worker_pid=$(cat "$pid_file")
  if kill -0 "$worker_pid" 2>/dev/null; then
    if [ -r "/proc/$worker_pid/cmdline" ]; then
      worker_command=$(tr '\\000' ' ' <"/proc/$worker_pid/cmdline" 2>/dev/null || true)
      case "$worker_command" in
        *"$binary"*) exit 0 ;;
      esac
    else
      exit 0
    fi
  fi
  rm -f "$pid_file"
fi

nohup env CLANKY_DATA_DIR="$data_dir" "$binary" serve </dev/null >>"$log_file" 2>&1 &
worker_pid=$!
printf '%s\\n' "$worker_pid" >"$pid_file"
`;
}

async function resolveProvisioningExecutionHostBinding(
  userId: string,
  options: StartProvisioningJobOptions,
  jobId: string,
): Promise<ExecutionHostBinding> {
  if (options.workspaceWorkerEnrollmentId) {
    if ((options.mode ?? "provision") !== "provision") {
      throw new ProvisioningFailedError(
        "invalid_execution_target",
        "verify_devbox",
        "Dedicated worker enrollments can only create a new workspace",
      );
    }
    return workspaceWorkerEnrollmentService.claimForProvisioning(
      userId,
      options.workspaceWorkerEnrollmentId,
      jobId,
    );
  }
  if (
    (options.mode === "rebuild" || options.mode === "restart")
    && options.workspaceId
  ) {
    const workspace = await getWorkspace(options.workspaceId);
    if (workspace?.provisioningHostBinding) {
      executionHostService.validateBinding(workspace.provisioningHostBinding, userId);
      return workspace.provisioningHostBinding;
    }
  }
  if (!options.executionHost) {
    throw new ProvisioningFailedError(
      "missing_execution_host",
      "verify_devbox",
      "Provisioning requires an execution host",
    );
  }
  await executionHostService.listHosts(userId);
  return executionHostService.getBinding(options.executionHost, userId);
}

async function buildWorkspaceSshTarget(
  binding: ExecutionHostBinding,
  status: DevboxStatusResult,
  credential: { password?: string },
): Promise<WorkspaceSshTargetInput | null> {
  const registeredServerId = getRegisteredSshServerId(binding.host);
  if (!registeredServerId) {
    return null;
  }

  const server = await getSshServerConfig(registeredServerId);
  const host = server?.address.trim();
  if (!host) {
    return null;
  }

  if (!status.sshEnabled) {
    throw new ProvisioningFailedError(
      "invalid_devbox_status",
      "devbox_status",
      "devbox status reported that the bundled SSH server is disabled",
    );
  }

  const username = status.sshUser?.trim();
  if (!username) {
    throw new ProvisioningFailedError(
      "invalid_devbox_status",
      "devbox_status",
      "devbox status did not include an SSH username for the workspace execution target",
    );
  }
  const port = status.sshPort;
  if (port === null) {
    throw new ProvisioningFailedError(
      "invalid_devbox_status",
      "devbox_status",
      "devbox status did not include an SSH port for the workspace execution target",
    );
  }
  const password = status.password?.trim() || credential.password?.trim();
  return {
    host,
    port,
    username,
    ...(password ? { password } : {}),
  };
}

function getProvisioningTargetKey(config: ProvisioningJob["config"]): string | null {
  const hostKey = config.executionHostBinding.targetKey;
  if (config.mode === "arise") {
    return `arise:${hostKey}`;
  }

  if (config.workspaceId) {
    return `workspace:${config.workspaceId}`;
  }
  if (config.targetDirectory) {
    return `directory:${hostKey}:${config.targetDirectory}`;
  }
  if (config.basePath) {
    const repositoryName = config.createNewRepository
      ? config.name
      : extractRepoName(config.repoUrl ?? "");
    return `directory:${hostKey}:${pathPosix.join(config.basePath, repositoryName)}`;
  }
  return null;
}

function resolveProvisioningTransport(
  userId: string,
  options: StartProvisioningJobOptions,
  mode: ProvisioningJob["config"]["mode"],
): ProvisioningTransport {
  if (
    (mode === "rebuild" || mode === "restart")
    && options.workspaceId
  ) {
    const existingWorker = workspaceWorkerEnrollmentService.getByWorkspace(
      userId,
      options.workspaceId,
    );
    const existingTransport = existingWorker ? "worker" : "ssh";
    if (options.transport && options.transport !== existingTransport) {
      throw new ProvisioningFailedError(
        "provisioning_transport_mismatch",
        "verify_devbox",
        "Workspace lifecycle jobs must keep the transport already attached to the workspace.",
      );
    }
    return existingTransport;
  }
  if (options.transport) {
    return options.transport;
  }
  if (mode === "provision" && !options.workspaceWorkerEnrollmentId) {
    return "worker";
  }
  if (options.workspaceId && workspaceWorkerEnrollmentService.getByWorkspace(userId, options.workspaceId)) {
    return "worker";
  }
  return "ssh";
}

function validateNewRepositoryFolderName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === ".." || name.includes("..")) {
    throw new ProvisioningFailedError(
      "invalid_workspace_folder_name",
      "prepare_directory",
      "Workspace name can only contain letters, numbers, dots, underscores, and hyphens when creating a new repository",
    );
  }
  if (name.startsWith("-") || name.startsWith(".")) {
    throw new ProvisioningFailedError(
      "invalid_workspace_folder_name",
      "prepare_directory",
      "Workspace name cannot start with a dot or hyphen when creating a new repository",
    );
  }
}

function buildDevboxArgs(
  command: "up" | "rebuild",
  options: {
    transport: ProvisioningTransport;
    devcontainerSubpath?: string;
    devboxTemplate?: string;
    githubUser?: string;
    startupCommand?: string;
    clearStartupCommand?: boolean;
  },
): string[] {
  const args: string[] = options.transport === "worker"
    ? [command, "--no-ssh", "--allow-missing-ssh", "--ports", "1"]
    : [command, "--ssh"];
  if (command === "up" && options.devboxTemplate) {
    args.push("--template", options.devboxTemplate);
  } else if (options.devcontainerSubpath) {
    args.push("--devcontainer-subpath", options.devcontainerSubpath);
  }
  if (options.githubUser) {
    args.push("--gh-user", options.githubUser);
  }
  if (options.clearStartupCommand) {
    args.push("--no-startup-command");
  } else if (options.startupCommand) {
    args.push("--startup-command", options.startupCommand);
  }
  return args;
}

export class ProvisioningManager {
  private readonly jobs = new Map<string, ProvisioningJobRecord>();

  constructor(
    private readonly maxLogEntries: number = DEFAULT_MAX_LOG_ENTRIES,
  ) {}

  private async cleanupWorkerEnrollment(
    userId: string,
    enrollmentId: string,
    jobId: string,
  ): Promise<void> {
    try {
      await meshManager.cleanupDedicatedWorker(userId, enrollmentId);
    } catch (error) {
      log.error("Failed to clean up automatic workspace worker enrollment", {
        enrollmentId,
        jobId,
        error: String(error),
      });
    }
  }

  private async resolveWorkerHostAddress(
    userId: string,
    binding: ExecutionHostBinding,
    options: StartProvisioningJobOptions,
    jobId: string,
    manual: boolean,
  ): Promise<string> {
    const address = validateWorkerHostAddress(options.workerHostAddress);
    if (manual) {
      return address;
    }
    const addresses = await executionHostDiscoveryService.listAccessibleIpv4Addresses(
      binding.host,
      {
        operationId: `provisioning-addresses:${jobId}`,
        directory: "/",
        provider: options.provider,
        localUserId: userId,
        sshPassword: options.password,
      },
    );
    if (!addresses.includes(address)) {
      throw new ProvisioningFailedError(
        "invalid_worker_host_address",
        "verify_devbox",
        "The worker host address must be one of the addresses discovered on the selected execution host.",
      );
    }
    return address;
  }

  async startJob(options: StartProvisioningJobOptions): Promise<ProvisioningJobSnapshot> {
    const owner = requireCurrentUser();
    const jobId = crypto.randomUUID();
    const mode = options.mode ?? "provision";
    const transport = resolveProvisioningTransport(owner.id, options, mode);
    if (transport === "worker" && options.workspaceWorkerEnrollmentId) {
      throw new ProvisioningFailedError(
        "invalid_execution_target",
        "verify_devbox",
        "Worker transport cannot use an existing dedicated worker enrollment as its provisioning target",
      );
    }
    const executionHostBinding = await resolveProvisioningExecutionHostBinding(
      owner.id,
      options,
      jobId,
    );
    const workerHostAddress = transport === "worker" && mode === "provision"
      ? await this.resolveWorkerHostAddress(
          owner.id,
          executionHostBinding,
          options,
          jobId,
          options.workerHostAddressManual === true,
        )
      : undefined;
    const existingWorkerEnrollment = transport === "worker"
      && (mode === "rebuild" || mode === "restart")
      && options.workspaceId
      ? workspaceWorkerEnrollmentService.getByWorkspace(owner.id, options.workspaceId)
      : null;
    const now = new Date().toISOString();
    const record: ProvisioningJobRecord = {
      job: {
        config: {
          id: jobId,
          name: options.name.trim(),
          executionHostBinding,
          transport,
          ...(options.workspaceWorkerEnrollmentId
            ? { workspaceWorkerEnrollmentId: options.workspaceWorkerEnrollmentId }
            : {}),
          ...(existingWorkerEnrollment
            ? { workerEnrollmentId: existingWorkerEnrollment.enrollment.id }
            : {}),
          ...(workerHostAddress ? { workerHostAddress } : {}),
          ...(options.workerHostAddressManual ? { workerHostAddressManual: true } : {}),
          repoUrl: normalizeOptionalValue(options.repoUrl),
          basePath: options.basePath.trim(),
          devcontainerSubpath: normalizeOptionalValue(options.devcontainerSubpath),
          devboxTemplate: normalizeOptionalValue(options.devboxTemplate),
          githubUser: normalizeOptionalValue(options.githubUser),
          provider: options.provider,
          mode,
          createNewRepository: options.createNewRepository === true,
          targetDirectory: normalizeOptionalValue(options.targetDirectory),
          workspaceId: normalizeOptionalValue(options.workspaceId),
          createdAt: now,
        },
        state: {
          status: "pending",
          updatedAt: now,
        },
      },
      logs: [],
      abortController: new AbortController(),
      owner,
      runnerActive: true,
      secretValues: options.password?.trim() ? [options.password.trim()] : [],
    };

    const targetKey = getProvisioningTargetKey(record.job.config);
    if (targetKey && this.hasActiveTarget(owner.id, targetKey)) {
      throw new ProvisioningFailedError(
        "provisioning_target_busy",
        "verify_devbox",
        "Another provisioning job is already running for this target",
      );
    }

    try {
      this.jobs.set(jobId, record);
      createProvisioningJob(owner.id, record.job);
    } catch (error) {
      this.jobs.delete(jobId);
      throw error;
    }
    emitJobStarted(record.job);

    const run = mode === "arise"
      ? () => this.runServerAriseJob(record, options.password)
      : mode === "rebuild" || mode === "restart"
        ? () => this.runExistingWorkspaceJob(record, options.password, mode)
        : () => this.runJob(record, options.password);
    void runWithCurrentUser(owner, run)
      .catch((error) => {
        log.error("Provisioning job crashed unexpectedly", {
          provisioningJobId: record.job.config.id,
          mode,
          error: String(error),
        });
      })
      .finally(() => {
        record.runnerActive = false;
      });

    return await this.getSnapshotOrThrow(jobId);
  }

  async getJobSnapshot(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }
    return await this.buildSnapshot(record);
  }

  getJobLogs(jobId: string): ProvisioningLogEntry[] | null {
    const record = this.getOrLoadRecord(jobId);
    return record ? [...record.logs] : null;
  }

  listJobs(): ProvisioningJob[] {
    const ownerId = requireCurrentUserId();
    const jobs = new Map(listProvisioningJobs(ownerId).map((job) => [job.config.id, job]));
    for (const record of this.jobs.values()) {
      if (record.owner.id === ownerId) {
        jobs.set(record.job.config.id, structuredClone(record.job));
      }
    }
    return [...jobs.values()].sort((left, right) =>
      right.state.updatedAt.localeCompare(left.state.updatedAt)
      || right.config.createdAt.localeCompare(left.config.createdAt));
  }

  async cancelJob(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }

    if (record.job.state.status === "running" || record.job.state.status === "pending") {
      record.abortController.abort();
      if (record.runnerActive) {
        appendSystemLog(record, this.maxLogEntries, "Cancellation requested", record.job.state.currentStep);
      } else {
        const completedAt = new Date().toISOString();
        const failure = buildError(
          "cancelled",
          record.job.state.currentStep ?? "verify_devbox",
          "Provisioning job was cancelled",
        );
        this.updateState(record, {
          status: "cancelled",
          error: failure,
          completedAt,
        });
        appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
        emitJobCancelled(record.job);
      }
    }

    return await this.buildSnapshot(record);
  }

  async dismissJob(jobId: string): Promise<boolean | null> {
    const record = this.getOrLoadRecord(jobId);
    if (!record) {
      return null;
    }
    const status = record.job.state.status;
    if (record.runnerActive || status === "pending" || status === "running") {
      throw new ProvisioningFailedError(
        "job_not_terminal",
        record.job.state.currentStep ?? "verify_devbox",
        "Provisioning is still finalizing and cannot be dismissed yet",
      );
    }

    const deleted = dismissProvisioningJob(record.owner.id, jobId);
    if (!deleted) {
      return false;
    }
    this.jobs.delete(jobId);
    emitJobDismissed(jobId);
    return true;
  }

  reconcileStartupState(): number {
    return markProvisioningJobsInterrupted(requireCurrentUserId());
  }

  async reconcileDedicatedWorkerStartupState(): Promise<void> {
    const userId = requireCurrentUserId();
    const interruptedJobs = listProvisioningJobs(userId).filter(
      (job) =>
        (job.state.status === "pending" || job.state.status === "running")
        && (job.config.mode ?? "provision") === "provision"
        && (job.config.workspaceWorkerEnrollmentId || job.config.workerEnrollmentId),
    );
    this.reconcileStartupState();

    for (const job of interruptedJobs) {
      const enrollmentId = job.config.workerEnrollmentId ?? job.config.workspaceWorkerEnrollmentId;
      if (!enrollmentId) {
        continue;
      }
      let workspaceDeleted = false;
      if (job.state.workspaceId) {
        try {
          const deletion = await workspaceManager.deleteWorkspace(job.state.workspaceId);
          workspaceDeleted = deletion.success;
          if (!deletion.success) {
            log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
              provisioningJobId: job.config.id,
              workspaceId: job.state.workspaceId,
              error: String(deletion.error),
            });
          }
        } catch (error) {
          log.warn("Failed to remove workspace from interrupted dedicated-worker provisioning", {
            provisioningJobId: job.config.id,
            workspaceId: job.state.workspaceId,
            error: String(error),
          });
        }
      }
      if (!workspaceDeleted) {
        try {
          const workspaceStillExists = job.state.workspaceId
            ? await workspaceManager.getWorkspace(job.state.workspaceId) !== null
            : false;
          await meshManager.cleanupDedicatedWorker(userId, enrollmentId, {
            preserveRegistration: workspaceStillExists,
          });
        } catch (error) {
          log.error("Failed to clean up dedicated worker after server restart", {
            provisioningJobId: job.config.id,
            enrollmentId,
            error: String(error),
          });
        }
      }
    }
  }

  resetForTesting(): void {
    for (const record of this.jobs.values()) {
      record.abortController.abort();
    }
    this.jobs.clear();
  }

  private async prepareWorkerLauncher(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    targetDirectory: string,
    containerWorkdir: string,
  ): Promise<WorkerPaths> {
    const paths = getWorkerPaths(targetDirectory, containerWorkdir);
    await this.runCmd(record, executor, {
      step: "prepare_directory",
      label: "Preparing persistent worker launcher",
      command: "mkdir",
      args: ["-p", paths.hostRoot],
    });
    await this.runCmd(record, executor, {
      step: "prepare_directory",
      label: "Allowing the workspace user to persist worker state",
      command: "chmod",
      args: ["1777", paths.hostRoot],
    });
    const written = await executor.writeFile(
      pathPosix.join(paths.hostRoot, "launcher.sh"),
      buildWorkerLauncher(paths),
    );
    if (!written) {
      throw new ProvisioningFailedError(
        "worker_launcher_write_failed",
        "prepare_directory",
        "Failed to write the persistent worker launcher.",
      );
    }
    await this.runCmd(record, executor, {
      step: "prepare_directory",
      label: "Making the worker launcher executable",
      command: "chmod",
      args: ["755", pathPosix.join(paths.hostRoot, "launcher.sh")],
    });
    return paths;
  }

  private async createWorkerEnrollment(
    record: ProvisioningJobRecord,
  ): Promise<void> {
    if (record.job.config.workerEnrollmentId) {
      return;
    }
    const created = await meshManager.createWorkspaceWorkerEnrollment(
      record.owner.id,
      `${record.job.config.name} worker`,
      900,
    );
    record.job.config.workerEnrollmentId = created.enrollment.id;
    record.workerEnrollmentToken = created.token;
    record.workerJoinCommand = created.workerJoinCommand;
    if (!record.secretValues.includes(created.token)) {
      record.secretValues.push(created.token);
    }
    try {
      updateProvisioningJob(record.owner.id, record.job);
    } catch (error) {
      await this.cleanupWorkerEnrollment(
        record.owner.id,
        created.enrollment.id,
        record.job.config.id,
      );
      throw error;
    }
  }

  private async runDevboxExec(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    cwd: string,
    args: string[],
    options: {
      step: ProvisioningStep;
      label: string;
      errorCode: string;
      errorMessage: string;
      captureStdout?: boolean;
    },
  ) {
    return await this.runCmd(record, executor, {
      step: options.step,
      label: options.label,
      command: "devbox",
      args: ["exec", "--", ...args],
      cwd,
      errorCode: options.errorCode,
      errorMessage: options.errorMessage,
      captureStdout: options.captureStdout,
    });
  }

  private async waitForWorkerEnrollment(
    record: ProvisioningJobRecord,
    enrollmentId: string,
  ): Promise<void> {
    const timeoutAt = Date.now() + WORKER_READINESS_TIMEOUT_MS;
    let lastHealthError: unknown;
    while (Date.now() < timeoutAt) {
      this.throwIfCancelled(record);
      const status = workspaceWorkerEnrollmentService.getStatus(
        record.owner.id,
        enrollmentId,
      );
      if (
        ["connected", "attached"].includes(status.enrollment.status)
        && status.worker?.grantStatus === "active"
        && status.worker.workerNodeId
      ) {
        const probe = createDeadlineSignal(
          record.abortController.signal,
          timeoutAt,
        );
        try {
          await meshManager.checkWorkerReachability(
            record.owner.id,
            status.worker.workerNodeId,
            { signal: probe.signal },
          );
          return;
        } catch (error) {
          if (record.abortController.signal.aborted) {
            throw new ProvisioningCancelledError("Provisioning job was cancelled");
          }
          lastHealthError = error;
        } finally {
          probe.dispose();
        }
      }
      if (["failed", "expired", "cancelled"].includes(status.enrollment.status)) {
        throw new ProvisioningFailedError(
          "workspace_worker_connection_failed",
          "test_connection",
          status.enrollment.errorMessage ?? "The workspace worker failed to connect.",
        );
      }
      const remainingMs = timeoutAt - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await waitForReadinessPoll(
        record.abortController.signal,
        Math.min(WORKER_READINESS_POLL_INTERVAL_MS, remainingMs),
      );
    }
    throw new ProvisioningFailedError(
      "workspace_worker_connection_timeout",
      "test_connection",
      `Timed out waiting for the workspace worker to become reachable.${
        lastHealthError ? ` Last health error: ${String(lastHealthError)}` : ""
      }`,
      { cause: lastHealthError },
    );
  }

  private async runJob(record: ProvisioningJobRecord, password?: string): Promise<void> {
    let createdWorkspaceId: string | undefined;

    try {
      const binding = record.job.config.executionHostBinding;
      if (!binding) {
        throw new ProvisioningFailedError(
          "missing_execution_host",
          "verify_devbox",
          "Provisioning requires an execution host",
        );
      }
      const serverSettings: ServerSettings = {
        agent: {
          provider: record.job.config.provider,
        },
      };
      const executor = await executionHostService.getCommandExecutor(binding, {
        operationId: `provisioning:${record.job.config.id}`,
        directory: "/",
        provider: record.job.config.provider,
        localUserId: record.owner.id,
        sshPassword: password,
      });
      const git = GitService.withExecutor(executor);

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.verifyDevbox(record, executor);

      setStep(record, this.maxLogEntries, "prepare_directory", "Preparing remote base directory");
      await this.runCmd(record, executor, {
        step: "prepare_directory",
        label: `Ensuring base path ${record.job.config.basePath}`,
        command: "mkdir",
        args: ["-p", record.job.config.basePath],
      });

      setStep(record, this.maxLogEntries, "clone_repo", "Preparing repository checkout");
      if (record.job.config.createNewRepository) {
        validateNewRepositoryFolderName(record.job.config.name);
      }
      const targetDirectory = record.job.config.createNewRepository
        ? pathPosix.join(record.job.config.basePath, record.job.config.name)
        : pathPosix.join(record.job.config.basePath, extractRepoName(record.job.config.repoUrl ?? ""));
      this.updateState(record, { targetDirectory });

      const targetExists = await executor.directoryExists(targetDirectory);
      if (record.job.config.createNewRepository) {
        if (!record.job.config.devboxTemplate) {
          throw new ProvisioningFailedError(
            "missing_devbox_template",
            "clone_repo",
            "A devbox template is required when creating a workspace without an existing repository",
          );
        }
        if (targetExists) {
          throw new ProvisioningFailedError(
            "clone_conflict",
            "clone_repo",
            `Target directory already exists: ${targetDirectory}`,
          );
        }
        await this.runCmd(record, executor, {
          step: "clone_repo",
          label: `Creating repository directory ${targetDirectory}`,
          command: "mkdir",
          args: ["-p", targetDirectory],
        });
        await this.runCmd(record, executor, {
          step: "clone_repo",
          label: `Initializing git repository in ${targetDirectory}`,
          command: "git",
          args: ["init", "-b", "main"],
          cwd: targetDirectory,
          errorCode: "git_init_failed",
          errorMessage: "Failed to initialize git repository",
        });
      } else if (!targetExists) {
        await this.runCmd(record, executor, {
          step: "clone_repo",
          label: `Cloning repository into ${targetDirectory}`,
          command: "git",
          args: ["clone", record.job.config.repoUrl ?? "", targetDirectory],
          timeout: GIT_CLONE_TIMEOUT_MS,
          streamOutput: true,
          longRunning: true,
          errorCode: "clone_failed",
          errorMessage: "Failed to clone repository",
        });
      } else {
        const existingRepo = await git.isGitRepo(targetDirectory);
        if (!existingRepo) {
          throw new ProvisioningFailedError(
            "clone_conflict",
            "clone_repo",
            `Target directory already exists and is not a git repository: ${targetDirectory}`,
          );
        }

        const remoteUrlResult = await executor.exec(
          "git",
          ["remote", "get-url", "origin"],
          {
            cwd: targetDirectory,
            signal: record.abortController.signal,
          },
        );
        this.throwIfCancelled(record);
        if (!remoteUrlResult.success) {
          throw new ProvisioningFailedError(
            "clone_conflict",
            "clone_repo",
            `Target directory already exists but its origin remote could not be verified: ${targetDirectory}`,
          );
        }

        if (normalizeRepoUrl(remoteUrlResult.stdout) !== normalizeRepoUrl(record.job.config.repoUrl ?? "")) {
          throw new ProvisioningFailedError(
            "clone_conflict",
            "clone_repo",
            `Target directory already exists with a different origin remote: ${targetDirectory}`,
          );
        }

        appendSystemLog(record, this.maxLogEntries, `Reusing existing checkout at ${targetDirectory}`, "clone_repo");
      }

      const workerTransport = record.job.config.transport === "worker";
      let workerLauncherPaths: WorkerPaths | undefined;
      const devboxOptions = {
        transport: workerTransport ? "worker" as const : "ssh" as const,
        devcontainerSubpath: record.job.config.devcontainerSubpath,
        devboxTemplate: record.job.config.devboxTemplate,
        githubUser: record.job.config.githubUser,
      };

      setStep(record, this.maxLogEntries, "devbox_up", "Starting devbox");
      await this.runCmd(record, executor, {
        step: "devbox_up",
        label: "Running devbox up",
        command: "devbox",
        args: buildDevboxArgs("up", {
          ...devboxOptions,
          ...(workerTransport ? { clearStartupCommand: true } : {}),
        }),
        cwd: targetDirectory,
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: "devbox_up_failed",
        errorMessage: "Failed to start devbox",
      });

      setStep(record, this.maxLogEntries, "devbox_status", "Reading devbox status");
      const statusResult = await this.runCmd(record, executor, {
        step: "devbox_status",
        label: "Reading devbox status",
        command: "devbox",
        args: ["status"],
        cwd: targetDirectory,
        errorCode: "invalid_devbox_status",
        errorMessage: "Failed to read devbox status",
        captureStdout: false,
      });
      let status = parseDevboxStatusOutput(statusResult.stdout);
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status reported that the environment is not running",
        );
      }

      let resolvedDirectory = status.workdir.trim() || targetDirectory;
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include a workdir value",
        );
      }

      if (workerTransport) {
        if (!status.workdir.trim()) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            "devbox status did not include a container workdir for the workspace worker",
          );
        }
        workerLauncherPaths = await this.prepareWorkerLauncher(
          record,
          executor,
          targetDirectory,
          resolvedDirectory,
        );
        await this.runCmd(record, executor, {
          step: "devbox_up",
          label: "Persisting the workspace worker startup hook",
          command: "devbox",
          args: buildDevboxArgs("up", {
            ...devboxOptions,
            startupCommand: `sh ${shellQuote(workerLauncherPaths.containerLauncher)}`,
          }),
          cwd: targetDirectory,
          timeout: DEVBOX_UP_TIMEOUT_MS,
          streamOutput: true,
          longRunning: true,
          errorCode: "devbox_up_failed",
          errorMessage: "Failed to persist the workspace worker startup hook",
        });
        const finalStatusResult = await this.runCmd(record, executor, {
          step: "devbox_status",
          label: "Reading devbox status after configuring the worker",
          command: "devbox",
          args: ["status"],
          cwd: targetDirectory,
          errorCode: "invalid_devbox_status",
          errorMessage: "Failed to read devbox status after configuring the worker",
          captureStdout: false,
        });
        status = parseDevboxStatusOutput(finalStatusResult.stdout);
        if (!status.running) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            "devbox status reported that the environment is not running after configuring the worker",
          );
        }
        const finalWorkdir = status.workdir.trim();
        if (finalWorkdir && finalWorkdir !== resolvedDirectory) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            "devbox workdir changed while configuring the workspace worker",
          );
        }
      }

      let devboxCredential = parseDevboxCredentialContent("");
      if (!status.password && status.hasCredentialFile && status.credentialPath) {
        const credentialContent = await executor.readFile(status.credentialPath);
        if (credentialContent) {
          devboxCredential = parseDevboxCredentialContent(credentialContent);
        }
      }

      const resolvedPassword = status.password?.trim() || devboxCredential.password?.trim();
      if (resolvedPassword && !record.secretValues.includes(resolvedPassword)) {
        record.secretValues.push(resolvedPassword);
      }
      const sshTarget = workerTransport
        ? undefined
        : await buildWorkspaceSshTarget(binding, status, devboxCredential);

      let workerPaths: WorkerPaths | undefined;
      if (workerTransport) {
        const workerHostAddress = validateWorkerHostAddress(record.job.config.workerHostAddress);
        let publishedPort;
        try {
          publishedPort = getSinglePublishedPort(status);
        } catch (error) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            String(error),
          );
        }
        workerPaths = workerLauncherPaths ?? getWorkerPaths(targetDirectory, resolvedDirectory);
        const workerEndpoint = `https://${workerHostAddress}:${publishedPort.hostPort}`;
        const workerBinary = workerPaths.containerBinary;
        const workerData = workerPaths.containerData;
        await this.createWorkerEnrollment(record);
        const enrollmentId = record.job.config.workerEnrollmentId;
        const joinCommand = record.workerJoinCommand?.replace(
          /^clanky(?=\s)/,
          () => shellQuote(workerBinary),
        );
        if (!enrollmentId || !joinCommand) {
          throw new ProvisioningFailedError(
            "missing_worker_enrollment",
            "devbox_up",
            "Automatic worker provisioning did not create an enrollment.",
          );
        }
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          [
            "env",
            `CLANKY_DATA_DIR=${workerData}`,
            workerBinary,
            "worker",
            "bootstrap",
            "--host",
            "0.0.0.0",
            "--port",
            String(publishedPort.containerPort),
            "--worker-directory",
            resolvedDirectory,
            "--instance-name",
            record.job.config.name,
            "--mesh-endpoint",
            workerEndpoint,
          ],
          {
            step: "devbox_up",
            label: "Bootstrapping the workspace worker",
            errorCode: "worker_bootstrap_failed",
            errorMessage: "Failed to bootstrap the workspace worker",
            captureStdout: false,
          },
        );
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          ["sh", workerPaths.containerLauncher],
          {
            step: "devbox_up",
            label: "Starting the workspace worker",
            errorCode: "worker_start_failed",
            errorMessage: "Failed to start the workspace worker",
            captureStdout: false,
          },
        );
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          ["sh", "-lc", `CLANKY_DATA_DIR=${shellQuote(workerData)} ${joinCommand}`],
          {
            step: "devbox_up",
            label: "Registering the workspace worker",
            errorCode: "worker_join_failed",
            errorMessage: "Failed to register the workspace worker",
            captureStdout: false,
          },
        );
        await this.waitForWorkerEnrollment(record, enrollmentId);
      }

      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Configured execution on ${binding.targetKey}`,
        "devbox_status",
      );

      setStep(record, this.maxLogEntries, "create_workspace", "Creating workspace record");
      // Always create a new workspace. Workspaces are identified by their
      // unique ID, not by directory+server_fingerprint. Two separate
      // devbox containers may share the same directory path and SSH
      // fingerprint but represent distinct workspaces.
      const workspace = await workspaceManager.createWorkspace({
        name: record.job.config.name,
        directory: resolvedDirectory,
        workspaceType: "git",
        serverSettings,
        ...(record.job.config.workerEnrollmentId
          ? {
              workspaceWorkerEnrollmentId: record.job.config.workerEnrollmentId,
              workspaceWorkerEnrollmentClaimedBy: record.job.config.id,
              provisioningHost: binding.host,
            }
          : record.job.config.workspaceWorkerEnrollmentId
          ? {
              workspaceWorkerEnrollmentId: record.job.config.workspaceWorkerEnrollmentId,
              workspaceWorkerEnrollmentClaimedBy: record.job.config.id,
              provisioningHost: binding.host,
            }
          : sshTarget
          ? {
              sshTarget,
              provisioningHost: binding.host,
            }
          : {
              executionHost: binding.host,
              provisioningHost: binding.host,
            }),
        skipValidation: true,
        sourceDirectory: record.job.state.targetDirectory,
        repoUrl: record.job.config.repoUrl,
        basePath: record.job.config.basePath,
        devcontainerSubpath: record.job.config.devcontainerSubpath,
      });
      createdWorkspaceId = workspace.id;
      this.updateState(record, {
        workspaceId: workspace.id,
        workspaceAction: "created",
      });
      appendSystemLog(record, this.maxLogEntries, `Created workspace ${workspace.name}`, "create_workspace");

      setStep(record, this.maxLogEntries, "test_connection", "Testing workspace connection");
      const connectionResult = await backendManager.testConnection(
        serverSettings,
        resolvedDirectory,
        workspace.executionHostBinding.host,
        undefined,
        workspace.executionHostBinding,
      );
      if (!connectionResult.success) {
        throw new ProvisioningFailedError(
          "connection_test_failed",
          "test_connection",
          connectionResult.error ?? "Workspace connection test failed",
        );
      }

      setStep(record, this.maxLogEntries, "workspace_ready");
      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: "completed",
        completedAt,
      });
      appendSystemLog(
        record,
        this.maxLogEntries,
        record.job.state.workspaceAction === "reused"
          ? `Workspace connection test succeeded. Existing workspace ${record.job.config.name} is ready.`
          : `Workspace connection test succeeded. Workspace ${record.job.config.name} was created successfully and is ready.`,
        "workspace_ready",
      );
      emitJobCompleted(record.job);
    } catch (error) {
      const cancelled =
        error instanceof ProvisioningCancelledError || record.abortController.signal.aborted;
      const failure = cancelled
        ? buildError(
            "cancelled",
            record.job.state.currentStep ?? "verify_devbox",
            "Provisioning job was cancelled",
          )
        : error instanceof ProvisioningFailedError
          ? buildError(error.code, error.step, error.message)
          : buildError(
              "provisioning_failed",
              record.job.state.currentStep ?? "verify_devbox",
              String(error),
            );

      if (createdWorkspaceId) {
        try {
          const deletion = await workspaceManager.deleteWorkspace(createdWorkspaceId);
          if (!deletion.success) {
            throw deletion.error;
          }
          if (record.job.state.workspaceId === createdWorkspaceId) {
            this.updateState(record, {
              workspaceId: undefined,
              workspaceAction: undefined,
            });
          }
          appendSystemLog(
            record,
            this.maxLogEntries,
            "Removed the partially created workspace after provisioning failure",
            "create_workspace",
          );
        } catch (cleanupError) {
          log.warn("Failed to remove partially created workspace after provisioning failure", {
            provisioningJobId: record.job.config.id,
            workspaceId: createdWorkspaceId,
            error: String(cleanupError),
          });
        }
      }

      const enrollmentToCleanUp = record.job.config.workerEnrollmentId
        ?? record.job.config.workspaceWorkerEnrollmentId;
      if (enrollmentToCleanUp && !createdWorkspaceId) {
        try {
          await meshManager.cleanupDedicatedWorker(
            record.owner.id,
            enrollmentToCleanUp,
          );
        } catch (cleanupError) {
          log.error("Failed to clean up dedicated worker after provisioning failure", {
            provisioningJobId: record.job.config.id,
            enrollmentId: enrollmentToCleanUp,
            error: String(cleanupError),
          });
        }
      }

      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
      });
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
    }
  }

  private async runExistingWorkspaceJob(
    record: ProvisioningJobRecord,
    password: string | undefined,
    mode: "rebuild" | "restart",
  ): Promise<void> {
    const action = mode === "restart"
      ? {
          progressLabel: "Restarting devbox",
          step: "devbox_up" as const,
          commandLabel: "Running devbox up",
          args: ["up"],
          errorCode: "devbox_restart_failed",
          errorMessage: "Failed to restart devbox",
          completionMessage: `Workspace connection test succeeded. Devbox for ${record.job.config.name} was restarted successfully.`,
          genericFailureCode: "restart_failed",
        }
      : {
          progressLabel: "Rebuilding devbox",
          step: "devbox_rebuild" as const,
          commandLabel: "Running devbox rebuild",
          args: ["rebuild"],
          errorCode: "devbox_rebuild_failed",
          errorMessage: "Failed to rebuild devbox",
          completionMessage: `Workspace connection test succeeded. Devbox for ${record.job.config.name} was rebuilt successfully.`,
          genericFailureCode: "rebuild_failed",
        };

    try {
      const targetDirectory = record.job.config.targetDirectory;
      if (!targetDirectory) {
        throw new ProvisioningFailedError(
          "missing_target_directory",
          "verify_devbox",
          `${mode === "restart" ? "Restart" : "Rebuild"} mode requires a target directory`,
        );
      }

      const workspaceId = record.job.config.workspaceId;
      if (!workspaceId) {
        throw new ProvisioningFailedError(
          "missing_workspace_id",
          "verify_devbox",
          `${mode === "restart" ? "Restart" : "Rebuild"} mode requires a workspace ID`,
        );
      }

      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        throw new ProvisioningFailedError(
          "workspace_not_found",
          "verify_devbox",
          `Workspace ${workspaceId} not found`,
        );
      }

      const devcontainerSubpath =
        record.job.config.devcontainerSubpath ?? workspace.devcontainerSubpath;
      if (devcontainerSubpath && record.job.config.devcontainerSubpath !== devcontainerSubpath) {
        record.job.config.devcontainerSubpath = devcontainerSubpath;
        updateProvisioningJob(record.owner.id, record.job);
      }

      const binding = record.job.config.executionHostBinding;
      const executor = await executionHostService.getCommandExecutor(binding, {
        operationId: `provisioning:${record.job.config.id}`,
        directory: targetDirectory,
        provider: record.job.config.provider,
        localUserId: record.owner.id,
        sshPassword: password,
      });
      const workerTransport = record.job.config.transport === "worker";
      const workerEnrollment = workerTransport && record.job.config.workerEnrollmentId
        ? workspaceWorkerEnrollmentService.getStatus(
            record.owner.id,
            record.job.config.workerEnrollmentId,
          )
        : null;
      let workerHostAddress: string | undefined;
      if (workerTransport) {
        const workerEndpoint = workerEnrollment?.worker?.workerEndpoint;
        if (!workerEndpoint) {
          throw new ProvisioningFailedError(
            "workspace_worker_not_connected",
            "verify_devbox",
            "The workspace worker is not connected.",
          );
        }
        try {
          const parsedEndpoint = new URL(workerEndpoint);
          workerHostAddress = validateWorkerHostAddress(parsedEndpoint.hostname);
        } catch (error) {
          if (error instanceof ProvisioningFailedError) {
            throw error;
          }
          throw new ProvisioningFailedError(
            "invalid_worker_endpoint",
            "verify_devbox",
            "The workspace worker endpoint is invalid.",
          );
        }
      }
      this.updateState(record, {
        targetDirectory,
        workspaceId,
        workspaceAction: "reused",
      });

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.verifyDevbox(record, executor);

      setStep(record, this.maxLogEntries, "prepare_directory", "Verifying target directory");
      const targetExists = await executor.directoryExists(targetDirectory);
      if (!targetExists) {
        throw new ProvisioningFailedError(
          "directory_not_found",
          "prepare_directory",
          `Target directory does not exist on the remote host: ${targetDirectory}`,
        );
      }
      appendSystemLog(record, this.maxLogEntries, `Target directory verified: ${targetDirectory}`, "prepare_directory");
      const workerLauncherPaths = workerTransport
        ? await this.prepareWorkerLauncher(record, executor, targetDirectory, workspace.directory)
        : undefined;

      setStep(record, this.maxLogEntries, action.step, action.progressLabel);
      await this.runCmd(record, executor, {
        step: action.step,
        label: action.commandLabel,
        command: "devbox",
        args: buildDevboxArgs(action.step === "devbox_rebuild" ? "rebuild" : "up", {
          transport: workerTransport ? "worker" : "ssh",
          devcontainerSubpath,
          githubUser: record.job.config.githubUser,
          ...(workerLauncherPaths
            ? {
                startupCommand: `sh ${shellQuote(workerLauncherPaths.containerLauncher)}`,
              }
            : {}),
        }),
        cwd: targetDirectory,
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: action.errorCode,
        errorMessage: action.errorMessage,
      });

      setStep(record, this.maxLogEntries, "devbox_status", "Reading devbox status");
      const statusResult = await this.runCmd(record, executor, {
        step: "devbox_status",
        label: "Reading devbox status",
        command: "devbox",
        args: ["status"],
        cwd: targetDirectory,
        errorCode: "invalid_devbox_status",
        errorMessage: "Failed to read devbox status",
        captureStdout: false,
      });
      const status = parseDevboxStatusOutput(statusResult.stdout);
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status reported that the environment is not running",
        );
      }

      let devboxCredential = parseDevboxCredentialContent("");
      if (!status.password && status.hasCredentialFile && status.credentialPath) {
        const credentialContent = await executor.readFile(status.credentialPath);
        if (credentialContent) {
          devboxCredential = parseDevboxCredentialContent(credentialContent);
        }
      }

      const resolvedDirectory = status.workdir.trim() || targetDirectory;
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include a workdir value",
        );
      }

      const serverSettings: ServerSettings = {
        agent: {
          provider: record.job.config.provider,
        },
      };
      const sshTarget = workerTransport
        ? undefined
        : await buildWorkspaceSshTarget(binding, status, devboxCredential);

      if (workerTransport) {
        const enrollmentId = record.job.config.workerEnrollmentId;
        if (!enrollmentId || !workerHostAddress) {
          throw new ProvisioningFailedError(
            "missing_worker_enrollment",
            "devbox_status",
            "The workspace worker enrollment is unavailable.",
          );
        }
        let publishedPort;
        try {
          publishedPort = getSinglePublishedPort(status);
        } catch (error) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            String(error),
          );
        }
        const paths = getWorkerPaths(targetDirectory, resolvedDirectory);
        const workerEndpoint = `https://${workerHostAddress}:${publishedPort.hostPort}`;
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          [
            "sh",
            "-lc",
            `if [ -s ${shellQuote(paths.containerPid)} ]; then kill "$(cat ${shellQuote(paths.containerPid)})" 2>/dev/null || true; rm -f ${shellQuote(paths.containerPid)}; fi`,
          ],
          {
            step: action.step,
            label: "Restarting the workspace worker",
            errorCode: "worker_stop_failed",
            errorMessage: "Failed to stop the previous workspace worker",
            captureStdout: false,
          },
        );
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          [
            "env",
            `CLANKY_DATA_DIR=${paths.containerData}`,
            paths.containerBinary,
            "worker",
            "bootstrap",
            "--host",
            "0.0.0.0",
            "--port",
            String(publishedPort.containerPort),
            "--worker-directory",
            resolvedDirectory,
            "--instance-name",
            record.job.config.name,
            "--mesh-endpoint",
            workerEndpoint,
          ],
          {
            step: action.step,
            label: "Refreshing the workspace worker configuration",
            errorCode: "worker_bootstrap_failed",
            errorMessage: "Failed to refresh the workspace worker configuration",
            captureStdout: false,
          },
        );
        await this.runDevboxExec(
          record,
          executor,
          targetDirectory,
          ["sh", paths.containerLauncher],
          {
            step: action.step,
            label: "Starting the workspace worker",
            errorCode: "worker_start_failed",
            errorMessage: "Failed to start the workspace worker",
            captureStdout: false,
          },
        );
        try {
          await meshManager.updateWorkspaceWorkerEndpoint(
            record.owner.id,
            enrollmentId,
            workerEndpoint,
          );
        } catch (error) {
          throw new ProvisioningFailedError(
            "workspace_worker_endpoint_update_failed",
            action.step,
            `Failed to update the workspace worker endpoint: ${String(error)}`,
          );
        }
        await this.waitForWorkerEnrollment(record, enrollmentId);
      }

      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Resolved execution on ${binding.targetKey}`,
        "devbox_status",
      );

      // Update the existing workspace's server settings (port/password may change after rebuild)
      const updatedWorkspace = await workspaceManager.updateWorkspace(workspaceId, {
        ...(workspace.directory !== resolvedDirectory
          ? { directory: resolvedDirectory }
          : {}),
        serverSettings,
        ...(sshTarget
          ? { sshTarget }
          : (
            isWorkspaceSshExecutionHostRef(workspace.executionHostBinding.host)
              ? {
                  executionHost: binding.host,
                  sshTarget: null,
                }
              : {}
          )),
        allowExecutionTargetChangeWithTerminals: true,
        ...(devcontainerSubpath !== workspace.devcontainerSubpath
          ? { devcontainerSubpath }
          : {}),
      });
      if (!updatedWorkspace) {
        throw new ProvisioningFailedError(
          "workspace_not_found",
          "devbox_status",
          `Workspace ${workspaceId} not found or could not be updated`,
        );
      }
      appendSystemLog(record, this.maxLogEntries, "Updated workspace server settings", "devbox_status");

      setStep(record, this.maxLogEntries, "test_connection", "Testing workspace connection");
      const connectionResult = await backendManager.testConnection(
        serverSettings,
        resolvedDirectory,
        undefined,
        undefined,
        updatedWorkspace.executionHostBinding,
      );
      if (!connectionResult.success) {
        throw new ProvisioningFailedError(
          "connection_test_failed",
          "test_connection",
          connectionResult.error ?? "Workspace connection test failed",
        );
      }

      setStep(record, this.maxLogEntries, "workspace_ready");
      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: "completed",
        completedAt,
      });
      appendSystemLog(
        record,
        this.maxLogEntries,
        action.completionMessage,
        "workspace_ready",
      );
      emitJobCompleted(record.job);
    } catch (error) {
      const cancelled =
        error instanceof ProvisioningCancelledError || record.abortController.signal.aborted;
      const failure = cancelled
        ? buildError(
            "cancelled",
            record.job.state.currentStep ?? "verify_devbox",
            "Provisioning job was cancelled",
          )
        : error instanceof ProvisioningFailedError
          ? buildError(error.code, error.step, error.message)
          : buildError(
              action.genericFailureCode,
              record.job.state.currentStep ?? "verify_devbox",
              String(error),
            );

      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
      });
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
    }
  }

  private async runServerAriseJob(
    record: ProvisioningJobRecord,
    password: string | undefined,
  ): Promise<void> {
    try {
      const binding = record.job.config.executionHostBinding;
      if (!binding) {
        throw new ProvisioningFailedError(
          "missing_execution_host",
          "verify_devbox",
          "Server arise mode requires an execution host",
        );
      }
      const executor = await executionHostService.getCommandExecutor(binding, {
        operationId: `provisioning:${record.job.config.id}`,
        directory: record.job.config.targetDirectory ?? "/",
        provider: record.job.config.provider,
        localUserId: record.owner.id,
        sshPassword: password,
      });

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.verifyDevbox(record, executor);

      setStep(record, this.maxLogEntries, "devbox_arise", "Running devbox arise");
      await this.runCmd(record, executor, {
        step: "devbox_arise",
        label: "Running devbox arise",
        command: "devbox",
        args: ["arise"],
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: "devbox_arise_failed",
        errorMessage: "Failed to run devbox arise",
      });

      setStep(record, this.maxLogEntries, "arise_complete");
      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: "completed",
        completedAt,
      });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Devbox arise completed successfully for ${record.job.config.name}.`,
        "arise_complete",
      );
      emitJobCompleted(record.job);
    } catch (error) {
      const cancelled =
        error instanceof ProvisioningCancelledError || record.abortController.signal.aborted;
      const failure = cancelled
        ? buildError(
            "cancelled",
            record.job.state.currentStep ?? "verify_devbox",
            "Provisioning job was cancelled",
          )
        : error instanceof ProvisioningFailedError
          ? buildError(error.code, error.step, error.message)
          : buildError(
              "arise_failed",
              record.job.state.currentStep ?? "verify_devbox",
              String(error),
            );

      const completedAt = new Date().toISOString();
      this.updateState(record, {
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
      });
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
    }
  }

  private async buildSnapshot(record: ProvisioningJobRecord): Promise<ProvisioningJobSnapshot> {
    const workspace = record.job.state.workspaceId
      ? await getWorkspace(record.job.state.workspaceId)
      : null;
    return {
      job: structuredClone(record.job),
      logs: [...record.logs],
      ...(workspace ? { workspace } : {}),
    };
  }

  private async getSnapshotOrThrow(jobId: string): Promise<ProvisioningJobSnapshot> {
    const snapshot = await this.getJobSnapshot(jobId);
    if (!snapshot) {
      throw new Error(`Provisioning job not found: ${jobId}`);
    }
    return snapshot;
  }

  private getOrLoadRecord(jobId: string): ProvisioningJobRecord | null {
    const owner = requireCurrentUser();
    const activeRecord = this.jobs.get(jobId);
    if (activeRecord) {
      return activeRecord.owner.id === owner.id ? activeRecord : null;
    }

    const persisted = loadProvisioningJob(owner.id, jobId);
    if (!persisted) {
      return null;
    }

    const record: ProvisioningJobRecord = {
      job: persisted.job,
      logs: persisted.logs,
      abortController: new AbortController(),
      owner,
      runnerActive: false,
      secretValues: [],
    };
    this.jobs.set(jobId, record);
    return record;
  }

  private hasActiveTarget(ownerId: string, targetKey: string): boolean {
    for (const record of this.jobs.values()) {
      if (
        record.owner.id === ownerId
        && (record.job.state.status === "pending" || record.job.state.status === "running")
        && getProvisioningTargetKey(record.job.config) === targetKey
      ) {
        return true;
      }
    }

    return listProvisioningJobs(ownerId).some((job) =>
      (job.state.status === "pending" || job.state.status === "running")
      && getProvisioningTargetKey(job.config) === targetKey);
  }

  private throwIfCancelled(record: ProvisioningJobRecord): void {
    if (record.abortController.signal.aborted) {
      throw new ProvisioningCancelledError("Provisioning job was cancelled");
    }
  }

  private async verifyDevbox(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
  ): Promise<void> {
    await this.runCmd(record, executor, {
      step: "verify_devbox",
      label: "Checking Devbox availability",
      command: "devbox",
      args: ["--help"],
      errorCode: "devbox_not_found",
      errorMessage: "Devbox is not installed or not available on PATH",
      captureStdout: false,
    });
  }

  private updateState(
    record: ProvisioningJobRecord,
    updates: Partial<ProvisioningJob["state"]>,
  ): void {
    record.job.state = {
      ...record.job.state,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    updateProvisioningJob(record.owner.id, record.job);
  }

  // Thin wrapper so runJob can call runProvisioningCommand without threading maxLogEntries everywhere.
  private runCmd(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: Parameters<typeof runProvisioningCommand>[2],
  ) {
    return runProvisioningCommand(record, executor, options, this.maxLogEntries);
  }
}

export const provisioningManager = new ProvisioningManager();
