import { backendManager } from "../backend-manager";
import type { CommandExecutor } from "../command-executor";
import { workspaceManager } from "../workspace-manager";
import { withWorkspaceRuntimeLock } from "../workspace-execution-lock";
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import { getWorkspace } from "../../persistence/workspaces";
import { updateProvisioningJob } from "../../persistence/provisioning-jobs";
import type {
  ProvisioningJob,
  EnvironmentStatusResult,
  ServerSettings,
} from "@/shared";
import { ENVIRONMENT_UP_TIMEOUT_MS } from "./constants";
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
} from "./worker-lifecycle";
import { shellQuote, type AutomaticWorkerChannel, type WorkerPaths } from "./worker-assets";
import type { ProvisioningResourceHandle } from "./attempt";
import type { ProvisioningJobRecord } from "./types";
import { isMeshOutboundRoute } from "@/shared/mesh";
import { getHarnessAdapterForProvider, type HarnessAdapter } from "@/shared/settings";
import { isProvisioningJobTerminal } from "@/shared/provisioning";
import { loadProvisioningJob } from "../../persistence/provisioning-jobs";
import {
  createProvisioningSshKeyLease,
  attachProvisioningSshKeyGrants,
  discardProvisioningSshKeyGrants,
} from "../ssh-key-access-service";
import { scopedSshAgentEnvironment } from "../ssh-agent-environment";

function buildEnvironmentArgs(
  command: "up" | "rebuild" | "restart",
  options: {
    devcontainerSubpath?: string;
    environmentTemplate?: string;
    githubUser?: string;
    startupCommand?: string;
    clearStartupCommand?: boolean;
    releaseChannel?: AutomaticWorkerChannel;
    runtimeAdapter?: HarnessAdapter;
  },
): string[] {
  const args: string[] = [command];
  if (options.environmentTemplate) {
    args.push("--template", options.environmentTemplate);
  }
  if (options.devcontainerSubpath) {
    args.push("--devcontainer-subpath", options.devcontainerSubpath);
  }
  if (options.githubUser) {
    args.push("--gh-user", options.githubUser);
  }
  if (options.releaseChannel) {
    args.push("--release-channel", options.releaseChannel);
  }
  if (options.runtimeAdapter) {
    args.push("--runtime-adapter", options.runtimeAdapter);
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
  ): Promise<void> {
    const attempt = this.ensureAttempt(record);
    let workspaceCleanup: ProvisioningResourceHandle | undefined;
    let workerEnrollmentCleanup: ProvisioningResourceHandle | undefined;
    let workerProcessCleanup: ProvisioningResourceHandle | undefined;
    let sshGrantCleanup: ProvisioningResourceHandle | undefined;

    try {
      const binding = record.job.config.executionHostBinding;
      if (!binding) {
        throw new ProvisioningFailedError(
          "missing_execution_host",
          "verify_environment",
          "Provisioning requires an execution host",
        );
      }
      const serverSettings: ServerSettings = {
        agent: {
          adapter: record.job.config.adapter ?? getHarnessAdapterForProvider(record.job.config.provider),
          provider: record.job.config.provider,
        },
      };
      const executor = await this.remoteExecutor.acquire(record, "/");

      setStep(record, this.maxLogEntries, "verify_environment", "Checking for environment");
      await this.remoteExecutor.verifyEnvironment(record, executor);

      setStep(record, this.maxLogEntries, "prepare_directory", "Preparing remote base directory");
      await this.remoteExecutor.prepareBaseDirectory(record, executor);
      setStep(record, this.maxLogEntries, "clone_repo", "Preparing repository checkout");
      if (record.job.config.sshKeyIds?.length) {
        sshGrantCleanup = attempt.registerCleanup("Initial SSH key grants", async () => {
          await discardProvisioningSshKeyGrants(record.owner.id, record.job.config.id);
        });
      }
      // Credential grants belong to this job; the host resolves its durable environment by checkout.
      const sshLease = await createProvisioningSshKeyLease({
        userId: record.owner.id,
        environmentId: record.job.config.id,
        provisioningOperationId: record.job.config.id,
        host: binding.host,
        keyIds: record.job.config.sshKeyIds ?? [],
        assertActive: () => {
          const saved = loadProvisioningJob(record.owner.id, record.job.config.id);
          if (record.abortController.signal.aborted || record.attempt !== attempt
            || !saved || isProvisioningJobTerminal(saved.job.state.status)) {
            throw new Error("The provisioning operation no longer authorizes SSH access.");
          }
        },
      });
      let targetDirectory: string;
      try {
        targetDirectory = await this.remoteExecutor.prepareRepository(
          record, executor, scopedSshAgentEnvironment(sshLease.socketPath),
        );
      } finally {
        await sshLease.close();
      }
      this.updateState(record, { targetDirectory });

      const automaticWorker = !record.job.config.workspaceWorkerEnrollmentId;
      const relayOnlyWorker = automaticWorker;
      let workerLauncherPaths: WorkerPaths | undefined;
      const environmentOptions = {
        devcontainerSubpath: record.job.config.devcontainerSubpath,
        environmentTemplate: record.job.config.environmentTemplate,
        githubUser: record.job.config.githubUser,
        releaseChannel: record.job.config.releaseChannel
          ?? (record.job.config.useClankyPrerelease ? "prerelease" as const : undefined),
        runtimeAdapter: automaticWorker ? serverSettings.agent.adapter : undefined,
      };

      setStep(record, this.maxLogEntries, "environment_up", "Starting environment");
      await this.runCmd(record, executor, {
        step: "environment_up",
        label: "Running environment up",
        command: "environment",
        args: buildEnvironmentArgs("up", {
          ...environmentOptions,
          ...(automaticWorker ? { clearStartupCommand: true } : {}),
        }),
        cwd: targetDirectory,
        timeout: ENVIRONMENT_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: "environment_up_failed",
        errorMessage: "Failed to start environment",
      });

      setStep(record, this.maxLogEntries, "environment_status", "Reading environment status");
      let status = await this.remoteExecutor.readEnvironmentStatus(
        record,
        executor,
        targetDirectory,
      );
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_environment_status",
          "environment_status",
          "environment status reported that the environment is not running",
        );
      }

      const resolvedDirectory = status.workdir.trim() || targetDirectory;
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_environment_status",
          "environment_status",
          "environment status did not include a workdir value",
        );
      }
      this.updateState(record, { resolvedDirectory, serverSettings });

      if (automaticWorker) {
        if (!status.workdir.trim()) {
          throw new ProvisioningFailedError(
            "invalid_environment_status",
            "environment_status",
            "environment status did not include a container workdir for the workspace worker",
          );
        }
        workerLauncherPaths = await this.workerLifecycle.prepareLauncher(
          record,
          executor,
          targetDirectory,
          resolvedDirectory,
        );
        await this.runCmd(record, executor, {
          step: "environment_up",
          label: "Persisting the workspace worker startup hook",
          command: "environment",
          args: buildEnvironmentArgs("up", {
            ...environmentOptions,
            startupCommand: `sh ${shellQuote(workerLauncherPaths.containerLauncher)} startup`,
          }),
          cwd: targetDirectory,
          timeout: ENVIRONMENT_UP_TIMEOUT_MS,
          streamOutput: true,
          longRunning: true,
          errorCode: "environment_up_failed",
          errorMessage: "Failed to persist the workspace worker startup hook",
        });
        status = await this.remoteExecutor.readEnvironmentStatus(
          record,
          executor,
          targetDirectory,
          { label: "Reading environment status after configuring the worker" },
        );
        if (!status.running) {
          throw new ProvisioningFailedError(
            "invalid_environment_status",
            "environment_status",
            "environment status reported that the environment is not running after configuring the worker",
          );
        }
        const finalWorkdir = status.workdir.trim();
        if (finalWorkdir && finalWorkdir !== resolvedDirectory) {
          throw new ProvisioningFailedError(
            "invalid_environment_status",
            "environment_status",
            "environment workdir changed while configuring the workspace worker",
          );
        }
      }

      if (automaticWorker) {
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
        "environment_status",
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
      if (sshGrantCleanup) {
        await attachProvisioningSshKeyGrants(record.owner.id, record.job.config.id, workspace.id);
      }
      appendSystemLog(record, this.maxLogEntries, `Created workspace ${workspace.name}`, "create_workspace");

      setStep(record, this.maxLogEntries, "test_connection", "Testing workspace connection");
      const connectionResult = await backendManager.testConnection(
        serverSettings,
        resolvedDirectory,
        workspace.executionHostBinding.host,
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
      sshGrantCleanup?.commit();
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
        record.job.state.currentStep ?? "verify_environment",
      );
    }
  }

  async runExistingWorkspace(
    record: ProvisioningJobRecord,
    mode: "rebuild" | "restart",
  ): Promise<void> {
    const workspaceId = record.job.config.workspaceId;
    const run = async () => await this.runExistingWorkspaceLocked(record, mode);
    if (workspaceId) await withWorkspaceRuntimeLock(workspaceId, run);
    else await run();
  }

  private async runExistingWorkspaceLocked(
    record: ProvisioningJobRecord,
    mode: "rebuild" | "restart",
  ): Promise<void> {
    const action = mode === "restart"
      ? {
          progressLabel: "Restarting environment",
          step: "environment_restart" as const,
          commandLabel: "Running environment restart",
          errorCode: "environment_restart_failed",
          errorMessage: "Failed to restart environment",
          completionMessage: `Workspace connection test succeeded. Environment for ${record.job.config.name} was restarted successfully.`,
          genericFailureCode: "restart_failed",
        }
      : {
          progressLabel: "Rebuilding environment",
          step: "environment_rebuild" as const,
          commandLabel: "Running environment rebuild",
          errorCode: "environment_rebuild_failed",
          errorMessage: "Failed to rebuild environment",
          completionMessage: `Workspace connection test succeeded. Environment for ${record.job.config.name} was rebuilt successfully.`,
          genericFailureCode: "rebuild_failed",
        };
    const attempt = this.ensureAttempt(record);

    try {
      const targetDirectory = record.job.config.targetDirectory;
      if (!targetDirectory) {
        throw new ProvisioningFailedError(
          "missing_target_directory",
          "verify_environment",
          `${mode === "restart" ? "Restart" : "Rebuild"} mode requires a target directory`,
        );
      }

      const workspaceId = record.job.config.workspaceId;
      if (!workspaceId) {
        throw new ProvisioningFailedError(
          "missing_workspace_id",
          "verify_environment",
          `${mode === "restart" ? "Restart" : "Rebuild"} mode requires a workspace ID`,
        );
      }

      const workspace = await getWorkspace(workspaceId);
      if (!workspace) {
        throw new ProvisioningFailedError(
          "workspace_not_found",
          "verify_environment",
          `Workspace ${workspaceId} not found`,
        );
      }
      record.job.config.adapter = workspace.serverSettings.agent.adapter;
      record.job.config.provider = workspace.serverSettings.agent.provider;
      updateProvisioningJob(record.owner.id, record.job);

      const devcontainerSubpath =
        record.job.config.devcontainerSubpath ?? workspace.devcontainerSubpath;
      if (devcontainerSubpath && record.job.config.devcontainerSubpath !== devcontainerSubpath) {
        record.job.config.devcontainerSubpath = devcontainerSubpath;
        updateProvisioningJob(record.owner.id, record.job);
      }

      const binding = record.job.config.executionHostBinding;
      const executor = await this.remoteExecutor.acquire(
        record,
        targetDirectory,
      );
      const automaticWorker = Boolean(record.job.config.workerEnrollmentId);
      const workerEnrollment = record.job.config.workerEnrollmentId
        ? workspaceWorkerEnrollmentService.getStatus(
            record.owner.id,
            record.job.config.workerEnrollmentId,
          )
        : null;
      const relayOnlyWorker = automaticWorker
        && (workerEnrollment?.worker?.route.kind === "relay"
          || isMeshOutboundRoute(workerEnrollment?.worker?.route));
      let workerHostAddress: string | undefined;
      if (automaticWorker && !relayOnlyWorker) {
        const workerEndpoint = workerEnrollment?.worker?.workerEndpoint;
        if (!workerEndpoint) {
          throw new ProvisioningFailedError(
            "workspace_worker_not_connected",
            "verify_environment",
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
            "verify_environment",
            "The workspace worker endpoint is invalid.",
          );
        }
      }
      this.updateState(record, {
        targetDirectory,
        workspaceId,
        workspaceAction: "reused",
      });

      setStep(record, this.maxLogEntries, "verify_environment", "Checking for environment");
      await this.remoteExecutor.verifyEnvironment(record, executor);

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
      const workerLauncherPaths = automaticWorker
        ? await this.workerLifecycle.prepareLauncher(record, executor, targetDirectory, workspace.directory)
        : undefined;

      setStep(record, this.maxLogEntries, action.step, action.progressLabel);
      const recoveredStatus = await this.runLifecycleCommand(record, executor, {
        step: action.step,
        label: action.commandLabel,
        command: "environment",
        args: buildEnvironmentArgs(mode, {
          devcontainerSubpath,
          githubUser: record.job.config.githubUser,
          releaseChannel: record.job.config.releaseChannel
            ?? (record.job.config.useClankyPrerelease ? "prerelease" : undefined),
          runtimeAdapter: workerLauncherPaths ? workspace.serverSettings.agent.adapter : undefined,
          ...(workerLauncherPaths
            ? {
                startupCommand: `sh ${shellQuote(workerLauncherPaths.containerLauncher)} update ${shellQuote(record.job.config.id)}`,
              }
            : {}),
        }),
        cwd: targetDirectory,
        timeout: ENVIRONMENT_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: action.errorCode,
        errorMessage: action.errorMessage,
      });

      setStep(record, this.maxLogEntries, "environment_status", "Reading environment status");
      const status = recoveredStatus ?? await this.remoteExecutor.readEnvironmentStatus(
        record,
        executor,
        targetDirectory,
      );
      if (!status.running) {
        throw new ProvisioningFailedError(
          "invalid_environment_status",
          "environment_status",
          "environment status reported that the environment is not running",
        );
      }

      const resolvedDirectory = status.workdir.trim() || targetDirectory;
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_environment_status",
          "environment_status",
          "environment status did not include a workdir value",
        );
      }

      const serverSettings = workspace.serverSettings;
      if (automaticWorker) {
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

      await backendManager.resetWorkspaceConnection(workspaceId);
      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Resolved execution on ${binding.targetKey}`,
        "environment_status",
      );

      const updatedWorkspace = await workspaceManager.updateWorkspace(workspaceId, {
        ...(workspace.directory !== resolvedDirectory
          ? { directory: resolvedDirectory }
          : {}),
        allowExecutionTargetChangeWithTerminals: true,
        ...(devcontainerSubpath !== workspace.devcontainerSubpath
          ? { devcontainerSubpath }
          : {}),
      });
      if (!updatedWorkspace) {
        throw new ProvisioningFailedError(
          "workspace_not_found",
          "environment_status",
          `Workspace ${workspaceId} not found or could not be updated`,
        );
      }
      appendSystemLog(record, this.maxLogEntries, "Updated workspace server settings", "environment_status");

      setStep(record, this.maxLogEntries, "test_connection", "Testing workspace connection");
      const connectionResult = await backendManager.testConnection(
        serverSettings,
        resolvedDirectory,
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
        record.job.state.currentStep ?? "verify_environment",
      );
    }
  }

  async runServerArise(
    record: ProvisioningJobRecord,
  ): Promise<void> {
    const attempt = this.ensureAttempt(record);
    try {
      const binding = record.job.config.executionHostBinding;
      if (!binding) {
        throw new ProvisioningFailedError(
          "missing_execution_host",
          "verify_environment",
          "Server arise mode requires an execution host",
        );
      }
      const executor = await this.remoteExecutor.acquire(
        record,
        record.job.config.targetDirectory ?? "/",
      );

      setStep(record, this.maxLogEntries, "verify_environment", "Checking for environment");
      await this.remoteExecutor.verifyEnvironment(record, executor);

      setStep(record, this.maxLogEntries, "environment_arise", "Running environment arise");
      await this.runCmd(record, executor, {
        step: "environment_arise",
        label: "Running environment arise",
        command: "environment",
        args: ["arise"],
        timeout: ENVIRONMENT_UP_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: "environment_arise_failed",
        errorMessage: "Failed to run environment arise",
      });

      await attempt.complete(
        `Environment arise completed successfully for ${record.job.config.name}.`,
        "arise_complete",
      );
    } catch (error) {
      await attempt.fail(
        error,
        "arise_failed",
        record.job.state.currentStep ?? "verify_environment",
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

  private async runLifecycleCommand(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    options: Parameters<ProvisioningRemoteExecutor["run"]>[2],
  ): Promise<EnvironmentStatusResult | undefined> {
    try {
      await this.runCmd(record, executor, options);
    } catch (error) {
      if (!(error instanceof ProvisioningFailedError)
        || error.code !== "provisioning_execution_unconfirmed") throw error;
      // Continue only with the existing status/worker/backend probes, never replay the command.
      this.updateState(record, {
        status: "verifying",
        recovery: { step: options.step, status: "verifying" },
      });
      appendSystemLog(record, this.maxLogEntries, "Command response lost. Verifying workspace recovery.", options.step);
      return await this.remoteExecutor.confirmLifecycleRecovery(
        record, executor, options.cwd ?? record.job.config.targetDirectory ?? "/",
      );
    }
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
