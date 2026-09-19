import { backendManager } from "../backend-manager";
import type { CommandExecutor } from "../command-executor";
import { workspaceManager } from "../workspace-manager";
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import { getWorkspace } from "../../persistence/workspaces";
import { updateProvisioningJob } from "../../persistence/provisioning-jobs";
import type {
  ProvisioningJob,
  ProvisioningTransport,
  ServerSettings,
} from "@/shared";
import { isWorkspaceSshExecutionHostRef } from "@/shared/execution-host";
import { DEVBOX_UP_TIMEOUT_MS } from "./constants";
import {
  ProvisioningFailedError,
} from "./errors";
import { ProvisioningAttempt } from "./attempt";
import {
  appendSystemLog,
  persistProvisioningState,
  setStep,
} from "./job-logger";
import type { RunCommandOptions } from "./command-runner";
import { validateWorkerHostAddress } from "./target-resolver";
import {
  ProvisioningRemoteExecutor,
} from "./remote-executor";
import {
  ProvisioningWorkerLifecycle,
  shellQuote,
  type WorkerPaths,
} from "./worker-lifecycle";
import type { ProvisioningResourceHandle } from "./attempt";
import type { ProvisioningJobRecord } from "./types";

function buildDevboxArgs(
  command: "up" | "rebuild",
  options: {
    transport: ProvisioningTransport;
    devcontainerSubpath?: string;
    devboxTemplate?: string;
    githubUser?: string;
    startupCommand?: string;
    clearStartupCommand?: boolean;
    relayOnlyWorker?: boolean;
  },
): string[] {
  const args: string[] = options.transport === "worker"
    ? [
        command,
        "--no-ssh",
        "--allow-missing-ssh",
        ...(options.relayOnlyWorker ? [] : ["--ports", "1"]),
      ]
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

export class ProvisioningWorkflows {
  constructor(
    private readonly maxLogEntries: number,
    private readonly remoteExecutor: ProvisioningRemoteExecutor,
    private readonly workerLifecycle: ProvisioningWorkerLifecycle,
  ) {}

  async runProvision(
    record: ProvisioningJobRecord,
    password?: string,
  ): Promise<void> {
    const attempt = this.ensureAttempt(record);
    let workspaceCleanup: ProvisioningResourceHandle | undefined;
    let workerEnrollmentCleanup: ProvisioningResourceHandle | undefined;
    let workerProcessCleanup: ProvisioningResourceHandle | undefined;

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
      const executor = await this.remoteExecutor.acquire(record, password, "/");

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.remoteExecutor.verifyDevbox(record, executor);

      setStep(record, this.maxLogEntries, "prepare_directory", "Preparing remote base directory");
      await this.remoteExecutor.prepareBaseDirectory(record, executor);
      setStep(record, this.maxLogEntries, "clone_repo", "Preparing repository checkout");
      const targetDirectory = await this.remoteExecutor.prepareRepository(
        record,
        executor,
      );
      this.updateState(record, { targetDirectory });

      const workerTransport = record.job.config.transport === "worker";
      const relayOnlyWorker = workerTransport
        && record.job.config.workerEnrollmentRoute === "relay";
      let workerLauncherPaths: WorkerPaths | undefined;
      const devboxOptions = {
        transport: workerTransport ? "worker" as const : "ssh" as const,
        devcontainerSubpath: record.job.config.devcontainerSubpath,
        devboxTemplate: record.job.config.devboxTemplate,
        githubUser: record.job.config.githubUser,
        relayOnlyWorker,
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
      let status = await this.remoteExecutor.readDevboxStatus(
        record,
        executor,
        targetDirectory,
      );
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status reported that the environment is not running",
        );
      }

      const resolvedDirectory = status.workdir.trim() || targetDirectory;
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include a workdir value",
        );
      }
      this.updateState(record, { resolvedDirectory, serverSettings });

      if (workerTransport) {
        if (!status.workdir.trim()) {
          throw new ProvisioningFailedError(
            "invalid_devbox_status",
            "devbox_status",
            "devbox status did not include a container workdir for the workspace worker",
          );
        }
        workerLauncherPaths = await this.workerLifecycle.prepareLauncher(
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
        status = await this.remoteExecutor.readDevboxStatus(
          record,
          executor,
          targetDirectory,
          "Reading devbox status after configuring the worker",
        );
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

      const devboxCredential = await this.remoteExecutor.readDevboxCredential(
        executor,
        status,
      );
      const resolvedPassword = status.password?.trim() || devboxCredential.password?.trim();
      if (resolvedPassword && !record.secretValues.includes(resolvedPassword)) {
        record.secretValues.push(resolvedPassword);
      }
      const sshTarget = workerTransport
        ? undefined
        : await this.remoteExecutor.buildWorkspaceSshTarget(
            binding,
            status,
            devboxCredential,
          );

      if (workerTransport) {
        const workerResult = await this.workerLifecycle.provisionWorker(
          record,
          executor,
          {
            targetDirectory,
            resolvedDirectory,
            status,
            workerLauncherPaths,
            workerHostAddress: record.job.config.workerHostAddress,
            relayOnlyWorker,
          },
        );
        workerEnrollmentCleanup = workerResult.enrollmentCleanup;
        workerProcessCleanup = workerResult.processCleanup;
      }

      appendSystemLog(
        record,
        this.maxLogEntries,
        `Configured execution on ${binding.targetKey}`,
        "devbox_status",
      );

      setStep(record, this.maxLogEntries, "create_workspace", "Creating workspace record");
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
      workspaceCleanup = attempt.registerCleanup(
        `workspace ${workspace.id}`,
        async () => {
          const deletion = await workspaceManager.deleteWorkspace(workspace.id);
          if (!deletion.success) {
            throw deletion.error;
          }
          if (record.job.state.workspaceId === workspace.id) {
            attempt.update({
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
        },
      );
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

      workspaceCleanup.commit();
      workerEnrollmentCleanup?.commit();
      workerProcessCleanup?.commit();
      record.workspaceWorkerEnrollmentCleanup?.commit();
      await attempt.complete(
        record.job.state.workspaceAction === "reused"
          ? `Workspace connection test succeeded. Existing workspace ${record.job.config.name} is ready.`
          : `Workspace connection test succeeded. Workspace ${record.job.config.name} was created successfully and is ready.`,
        "workspace_ready",
      );
    } catch (error) {
      await attempt.fail(
        error,
        "provisioning_failed",
        record.job.state.currentStep ?? "verify_devbox",
      );
    }
  }

  async runExistingWorkspace(
    record: ProvisioningJobRecord,
    password: string | undefined,
    mode: "rebuild" | "restart",
  ): Promise<void> {
    const action = mode === "restart"
      ? {
          progressLabel: "Restarting devbox",
          step: "devbox_up" as const,
          commandLabel: "Running devbox up",
          errorCode: "devbox_restart_failed",
          errorMessage: "Failed to restart devbox",
          completionMessage: `Workspace connection test succeeded. Devbox for ${record.job.config.name} was restarted successfully.`,
          genericFailureCode: "restart_failed",
        }
      : {
          progressLabel: "Rebuilding devbox",
          step: "devbox_rebuild" as const,
          commandLabel: "Running devbox rebuild",
          errorCode: "devbox_rebuild_failed",
          errorMessage: "Failed to rebuild devbox",
          completionMessage: `Workspace connection test succeeded. Devbox for ${record.job.config.name} was rebuilt successfully.`,
          genericFailureCode: "rebuild_failed",
        };
    const attempt = this.ensureAttempt(record);

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
      const executor = await this.remoteExecutor.acquire(
        record,
        password,
        targetDirectory,
      );
      const workerTransport = record.job.config.transport === "worker";
      const workerEnrollment = workerTransport && record.job.config.workerEnrollmentId
        ? workspaceWorkerEnrollmentService.getStatus(
            record.owner.id,
            record.job.config.workerEnrollmentId,
          )
        : null;
      const relayOnlyWorker = workerTransport
        && workerEnrollment?.worker?.route.kind === "relay";
      let workerHostAddress: string | undefined;
      if (workerTransport && !relayOnlyWorker) {
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
      await this.remoteExecutor.verifyDevbox(record, executor);

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
        ? await this.workerLifecycle.prepareLauncher(record, executor, targetDirectory, workspace.directory)
        : undefined;

      setStep(record, this.maxLogEntries, action.step, action.progressLabel);
      await this.runCmd(record, executor, {
        step: action.step,
        label: action.commandLabel,
        command: "devbox",
        args: buildDevboxArgs(action.step === "devbox_rebuild" ? "rebuild" : "up", {
          transport: workerTransport ? "worker" : "ssh",
          relayOnlyWorker,
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
      const status = await this.remoteExecutor.readDevboxStatus(
        record,
        executor,
        targetDirectory,
      );
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status reported that the environment is not running",
        );
      }

      const devboxCredential = await this.remoteExecutor.readDevboxCredential(
        executor,
        status,
      );

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
        : await this.remoteExecutor.buildWorkspaceSshTarget(
            binding,
            status,
            devboxCredential,
          );

      if (workerTransport) {
        await this.workerLifecycle.refreshWorker(
          record,
          executor,
          {
            targetDirectory,
            resolvedDirectory,
            status,
            workerHostAddress,
            relayOnlyWorker,
            step: action.step,
          },
        );
      }

      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Resolved execution on ${binding.targetKey}`,
        "devbox_status",
      );

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

      await attempt.complete(action.completionMessage, "workspace_ready");
    } catch (error) {
      await attempt.fail(
        error,
        action.genericFailureCode,
        record.job.state.currentStep ?? "verify_devbox",
      );
    }
  }

  async runServerArise(
    record: ProvisioningJobRecord,
    password: string | undefined,
  ): Promise<void> {
    const attempt = this.ensureAttempt(record);
    try {
      const binding = record.job.config.executionHostBinding;
      if (!binding) {
        throw new ProvisioningFailedError(
          "missing_execution_host",
          "verify_devbox",
          "Server arise mode requires an execution host",
        );
      }
      const executor = await this.remoteExecutor.acquire(
        record,
        password,
        record.job.config.targetDirectory ?? "/",
      );

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.remoteExecutor.verifyDevbox(record, executor);

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

      await attempt.complete(
        `Devbox arise completed successfully for ${record.job.config.name}.`,
        "arise_complete",
      );
    } catch (error) {
      await attempt.fail(
        error,
        "arise_failed",
        record.job.state.currentStep ?? "verify_devbox",
      );
    }
  }

  private ensureAttempt(record: ProvisioningJobRecord): ProvisioningAttempt {
    const attempt = record.attempt ?? new ProvisioningAttempt({
      record,
      maxLogEntries: this.maxLogEntries,
    });
    record.attempt = attempt;
    return attempt;
  }

  private updateState(
    record: ProvisioningJobRecord,
    updates: Partial<ProvisioningJob["state"]>,
  ): void {
    if (record.attempt) {
      record.attempt.update(updates);
      return;
    }
    persistProvisioningState(record, updates, "ProvisioningWorkflows.updateState");
  }

  private runCmd(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: RunCommandOptions,
  ) {
    return this.remoteExecutor.run(record, executor, options);
  }
}
