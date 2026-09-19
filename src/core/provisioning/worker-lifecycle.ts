import { posix as pathPosix } from "node:path";
import type { CommandExecutor, CommandResult } from "../command-executor";
import { meshManager } from "../mesh-manager";
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import type {
  DevboxStatusResult,
  ProvisioningStep,
} from "@/shared";
import { isValidWorkerHostAddress } from "@/shared";
import {
  WORKER_READINESS_POLL_INTERVAL_MS,
  WORKER_READINESS_TIMEOUT_MS,
} from "./constants";
import {
  ProvisioningCancelledError,
  ProvisioningFailedError,
} from "./errors";
import type { ProvisioningResourceHandle } from "./attempt";
import {
  getSinglePublishedPort,
} from "./devbox-utils";
import {
  runProvisioningCommand,
  type RunCommandOptions,
} from "./command-runner";
import type { ProvisioningJobRecord } from "./types";
import { updateProvisioningJob } from "../../persistence/provisioning-jobs";

export interface WorkerPaths {
  hostRoot: string;
  containerRoot: string;
  containerBinary: string;
  containerData: string;
  containerLauncher: string;
  containerLog: string;
  containerPid: string;
}

export interface WorkerProvisioningOptions {
  targetDirectory: string;
  resolvedDirectory: string;
  status: DevboxStatusResult;
  workerLauncherPaths?: WorkerPaths;
  workerHostAddress?: string;
  relayOnlyWorker: boolean;
}

export interface WorkerRefreshOptions {
  targetDirectory: string;
  resolvedDirectory: string;
  status: DevboxStatusResult;
  workerHostAddress?: string;
  relayOnlyWorker: boolean;
  step: ProvisioningStep;
}

export interface WorkerProvisioningResult {
  enrollmentCleanup?: ProvisioningResourceHandle;
  processCleanup?: ProvisioningResourceHandle;
}

const WORKER_INSTALLER_REVISION =
  "1e73c9a4b84bb2282d5a6fd8463f9a9f62c26c67";
const WORKER_INSTALLER_SHA256 =
  "d377a7ed04b150781b94cb0af97e6f7a2efe2c8d12dae1a1f0aa825306ea28f3";

type ProvisioningCommandRunner = (
  record: ProvisioningJobRecord,
  executor: CommandExecutor,
  options: RunCommandOptions,
  maxLogEntries: number,
) => Promise<CommandResult>;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function getWorkerPaths(
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
curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/pablozaiden/installer/${WORKER_INSTALLER_REVISION}/install.sh -o "$installer"
printf '%s  %s\\n' ${WORKER_INSTALLER_SHA256} "$installer" | sha256sum -c -
HOME="$install_home" sh "$installer" pablozaiden/clanky --install-dir "$install_dir" --checksum required
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

export class ProvisioningWorkerLifecycle {
  constructor(
    private readonly maxLogEntries: number,
    private readonly commandRunner: ProvisioningCommandRunner = runProvisioningCommand,
  ) {}

  async prepareLauncher(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    targetDirectory: string,
    containerWorkdir: string,
  ): Promise<WorkerPaths> {
    const paths = getWorkerPaths(targetDirectory, containerWorkdir);
    await this.runCommand(record, executor, {
      step: "prepare_directory",
      label: "Preparing persistent worker launcher",
      command: "mkdir",
      args: ["-p", paths.hostRoot],
    });
    await this.runCommand(record, executor, {
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
    await this.runCommand(record, executor, {
      step: "prepare_directory",
      label: "Making the worker launcher executable",
      command: "chmod",
      args: ["755", pathPosix.join(paths.hostRoot, "launcher.sh")],
    });
    return paths;
  }

  async createEnrollment(
    record: ProvisioningJobRecord,
  ): Promise<ProvisioningResourceHandle | undefined> {
    if (record.job.config.workerEnrollmentId) {
      return undefined;
    }
    const created = await meshManager.createWorkspaceWorkerEnrollment(
      record.owner.id,
      `${record.job.config.name} worker`,
      900,
      record.job.config.workerEnrollmentRoute ?? "direct",
    );
    record.job.config.workerEnrollmentId = created.enrollment.id;
    record.workerEnrollmentToken = created.token;
    record.workerJoinCommand = created.workerJoinCommand;
    if (!record.secretValues.includes(created.token)) {
      record.secretValues.push(created.token);
    }
    const cleanup = record.attempt?.registerCleanup(
      `workspace worker enrollment ${created.enrollment.id}`,
      async () => {
        await meshManager.cleanupDedicatedWorker(
          record.owner.id,
          created.enrollment.id,
        );
      },
    );
    updateProvisioningJob(record.owner.id, record.job);
    return cleanup;
  }

  async provisionWorker(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: WorkerProvisioningOptions,
  ): Promise<WorkerProvisioningResult> {
    const workerHostAddress = options.relayOnlyWorker
      ? undefined
      : this.validateWorkerHostAddress(options.workerHostAddress);
    let publishedPort;
    if (!options.relayOnlyWorker) {
      try {
        publishedPort = getSinglePublishedPort(options.status);
      } catch (error) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          String(error),
        );
      }
    }

    const workerPaths = options.workerLauncherPaths
      ?? getWorkerPaths(options.targetDirectory, options.resolvedDirectory);
    const workerEndpoint = options.relayOnlyWorker
      ? undefined
      : `https://${workerHostAddress!}:${publishedPort!.hostPort}`;
    const workerBinary = workerPaths.containerBinary;
    const workerData = workerPaths.containerData;
    const enrollmentCleanup = await this.createEnrollment(record);
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

    const processCleanup = record.attempt?.registerCleanup(
      `workspace worker process ${workerPaths.containerPid}`,
      async () => {
        await this.stopWorkerProcess(
          executor,
          options.targetDirectory,
          workerPaths.containerPid,
        );
      },
    );

    await this.runDevboxExec(
      record,
      executor,
      options.targetDirectory,
      [
        "env",
        `CLANKY_DATA_DIR=${workerData}`,
        workerBinary,
        "worker",
        "bootstrap",
        "--worker-directory",
        options.resolvedDirectory,
        "--instance-name",
        record.job.config.name,
        ...(options.relayOnlyWorker
          ? ["--relay-only"]
          : [
              "--host",
              "0.0.0.0",
              "--port",
              String(publishedPort!.containerPort),
              "--mesh-endpoint",
              workerEndpoint!,
            ]),
      ],
      {
        step: "devbox_up",
        label: "Bootstrapping the workspace worker",
        errorCode: "worker_bootstrap_failed",
        errorMessage: "Failed to bootstrap the workspace worker",
        captureStdout: false,
      },
    );
    if (!options.relayOnlyWorker) {
      await this.runDevboxExec(
        record,
        executor,
        options.targetDirectory,
        ["sh", workerPaths.containerLauncher],
        {
          step: "devbox_up",
          label: "Starting the workspace worker",
          errorCode: "worker_start_failed",
          errorMessage: "Failed to start the workspace worker",
          captureStdout: false,
        },
      );
    }
    await this.runDevboxExec(
      record,
      executor,
      options.targetDirectory,
      ["sh", "-lc", `CLANKY_DATA_DIR=${shellQuote(workerData)} ${joinCommand}`],
      {
        step: "devbox_up",
        label: "Registering the workspace worker",
        errorCode: "worker_join_failed",
        errorMessage: "Failed to register the workspace worker",
        captureStdout: false,
      },
    );
    if (options.relayOnlyWorker) {
      await this.runDevboxExec(
        record,
        executor,
        options.targetDirectory,
        ["sh", workerPaths.containerLauncher],
        {
          step: "devbox_up",
          label: "Starting the workspace worker",
          errorCode: "worker_start_failed",
          errorMessage: "Failed to start the workspace worker",
          captureStdout: false,
        },
      );
    }
    await this.waitForEnrollment(record, enrollmentId);
    return { enrollmentCleanup, processCleanup };
  }

  async refreshWorker(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: WorkerRefreshOptions,
  ): Promise<void> {
    const enrollmentId = record.job.config.workerEnrollmentId;
    const workerHostAddress = options.relayOnlyWorker
      ? undefined
      : this.validateWorkerHostAddress(options.workerHostAddress);
    if (!enrollmentId || (!options.relayOnlyWorker && !workerHostAddress)) {
      throw new ProvisioningFailedError(
        "missing_worker_enrollment",
        "devbox_status",
        "The workspace worker enrollment is unavailable.",
      );
    }
    let publishedPort;
    if (!options.relayOnlyWorker) {
      try {
        publishedPort = getSinglePublishedPort(options.status);
      } catch (error) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          String(error),
        );
      }
    }
    const paths = getWorkerPaths(options.targetDirectory, options.resolvedDirectory);
    const workerEndpoint = options.relayOnlyWorker
      ? undefined
      : `https://${workerHostAddress!}:${publishedPort?.hostPort ?? ""}`;
    await this.runDevboxExec(
      record,
      executor,
      options.targetDirectory,
      [
        "sh",
        "-lc",
        `if [ -s ${shellQuote(paths.containerPid)} ]; then kill "$(cat ${shellQuote(paths.containerPid)})" 2>/dev/null || true; rm -f ${shellQuote(paths.containerPid)}; fi`,
      ],
      {
        step: options.step,
        label: "Restarting the workspace worker",
        errorCode: "worker_stop_failed",
        errorMessage: "Failed to stop the previous workspace worker",
        captureStdout: false,
      },
    );
    await this.runDevboxExec(
      record,
      executor,
      options.targetDirectory,
      [
        "env",
        `CLANKY_DATA_DIR=${paths.containerData}`,
        paths.containerBinary,
        "worker",
        "bootstrap",
        "--worker-directory",
        options.resolvedDirectory,
        "--instance-name",
        record.job.config.name,
        ...(options.relayOnlyWorker
          ? ["--relay-only"]
          : [
              "--host",
              "0.0.0.0",
              "--port",
              String(publishedPort!.containerPort),
              "--mesh-endpoint",
              workerEndpoint!,
            ]),
      ],
      {
        step: options.step,
        label: "Refreshing the workspace worker configuration",
        errorCode: "worker_bootstrap_failed",
        errorMessage: "Failed to refresh the workspace worker configuration",
        captureStdout: false,
      },
    );
    await this.runDevboxExec(
      record,
      executor,
      options.targetDirectory,
      ["sh", paths.containerLauncher],
      {
        step: options.step,
        label: "Starting the workspace worker",
        errorCode: "worker_start_failed",
        errorMessage: "Failed to start the workspace worker",
        captureStdout: false,
      },
    );
    if (workerEndpoint) {
      try {
        await meshManager.updateWorkspaceWorkerEndpoint(
          record.owner.id,
          enrollmentId,
          workerEndpoint,
        );
      } catch (error) {
        throw new ProvisioningFailedError(
          "workspace_worker_endpoint_update_failed",
          options.step,
          `Failed to update the workspace worker endpoint: ${String(error)}`,
        );
      }
    }
    await this.waitForEnrollment(record, enrollmentId);
  }

  async waitForEnrollment(
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
  ): Promise<CommandResult> {
    return await this.runCommand(record, executor, {
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

  private async stopWorkerProcess(
    executor: CommandExecutor,
    cwd: string,
    pidPath: string,
  ): Promise<void> {
    const result = await executor.exec(
      "sh",
      [
        "-lc",
        `if [ -s ${shellQuote(pidPath)} ]; then kill "$(cat ${shellQuote(pidPath)})" 2>/dev/null || true; rm -f ${shellQuote(pidPath)}; fi`,
      ],
      { cwd },
    );
    if (!result.success) {
      throw new Error(result.stderr.trim() || "Failed to stop the workspace worker process");
    }
  }

  private validateWorkerHostAddress(value: string | undefined): string {
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

  private throwIfCancelled(record: ProvisioningJobRecord): void {
    if (record.abortController.signal.aborted) {
      throw new ProvisioningCancelledError("Provisioning job was cancelled");
    }
  }

  private async runCommand(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: RunCommandOptions,
  ): Promise<CommandResult> {
    return await this.commandRunner(
      record,
      executor,
      options,
      this.maxLogEntries,
    );
  }
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
