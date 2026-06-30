import { posix as pathPosix } from "node:path";
import { backendManager } from "../backend-manager";
import type { CommandExecutor } from "../command-executor";
import { GitService } from "../git-service";
import { createLogger } from "../logger";
import { sshServerManager } from "../ssh-server-manager";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  updateWorkspace,
} from "../../persistence/workspaces";
import type {
  ProvisioningJob,
  ProvisioningJobSnapshot,
  ProvisioningLogEntry,
  ServerSettings,
} from "../../types";
import { DEFAULT_JOB_RETENTION_MS, DEFAULT_MAX_LOG_ENTRIES, DEVBOX_UP_TIMEOUT_MS, GIT_CLONE_TIMEOUT_MS } from "./constants";
import { buildError, getPublishedPortFallback, parseDevboxCredentialContent, parseDevboxStatusOutput } from "./devbox-utils";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import { emitJobCancelled, emitJobCompleted, emitJobFailed, emitJobStarted } from "./job-events";
import { appendSystemLog, setStep } from "./job-logger";
import { runProvisioningCommand } from "./command-runner";
import { extractRepoName, normalizeRepoUrl } from "./repo-utils";
import type { ProvisioningJobRecord, StartProvisioningJobOptions } from "./types";

const log = createLogger("core:provisioning-manager");

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    devcontainerSubpath?: string;
    devboxTemplate?: string;
    githubUser?: string;
  },
): string[] {
  const args: string[] = [command];
  if (command === "up" && options.devboxTemplate) {
    args.push("--template", options.devboxTemplate);
  } else if (options.devcontainerSubpath) {
    args.push("--devcontainer-subpath", options.devcontainerSubpath);
  }
  if (options.githubUser) {
    args.push("--gh-user", options.githubUser);
  }
  return args;
}

export class ProvisioningManager {
  private readonly jobs = new Map<string, ProvisioningJobRecord>();

  constructor(
    private readonly jobRetentionMs: number = DEFAULT_JOB_RETENTION_MS,
    private readonly maxLogEntries: number = DEFAULT_MAX_LOG_ENTRIES,
  ) {}

  async startJob(options: StartProvisioningJobOptions): Promise<ProvisioningJobSnapshot> {
    const now = new Date().toISOString();
    const jobId = crypto.randomUUID();
    const mode = options.mode ?? "provision";
    const record: ProvisioningJobRecord = {
      job: {
        config: {
          id: jobId,
          name: options.name.trim(),
          sshServerId: options.sshServerId.trim(),
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
    };

    this.jobs.set(jobId, record);
    emitJobStarted(record.job);

    if (mode === "arise") {
      void this.runServerAriseJob(record, options.password).catch((error) => {
        log.error("Provisioning server-level arise job crashed unexpectedly", {
          provisioningJobId: record.job.config.id,
          mode,
          error: String(error),
        });
      });
    } else if (mode === "rebuild" || mode === "restart") {
      void this.runExistingWorkspaceJob(record, options.password, mode).catch((error) => {
        log.error("Provisioning existing-workspace job crashed unexpectedly", {
          provisioningJobId: record.job.config.id,
          mode,
          error: String(error),
        });
      });
    } else {
      void this.runJob(record, options.password).catch((error) => {
        log.error("Provisioning job crashed unexpectedly", {
          provisioningJobId: record.job.config.id,
          error: String(error),
        });
      });
    }

    return await this.getSnapshotOrThrow(jobId);
  }

  async getJobSnapshot(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.jobs.get(jobId);
    if (!record) {
      return null;
    }
    return await this.buildSnapshot(record);
  }

  getJobLogs(jobId: string): ProvisioningLogEntry[] | null {
    const record = this.jobs.get(jobId);
    return record ? [...record.logs] : null;
  }

  async cancelJob(jobId: string): Promise<ProvisioningJobSnapshot | null> {
    const record = this.jobs.get(jobId);
    if (!record) {
      return null;
    }

    if (record.job.state.status === "running" || record.job.state.status === "pending") {
      record.abortController.abort();
      appendSystemLog(record, this.maxLogEntries, "Cancellation requested", record.job.state.currentStep);
    }

    return await this.buildSnapshot(record);
  }

  resetForTesting(): void {
    for (const record of this.jobs.values()) {
      record.abortController.abort();
      if (record.cleanupTimer) {
        clearTimeout(record.cleanupTimer);
      }
    }
    this.jobs.clear();
  }

  private async runJob(record: ProvisioningJobRecord, password?: string): Promise<void> {
    let createdWorkspaceId: string | undefined;

    try {
      const { server, executor } = await sshServerManager.getCommandExecutor(
        record.job.config.sshServerId,
        password,
      );
      const git = GitService.withExecutor(executor);

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.runCmd(record, executor, {
        step: "verify_devbox",
        label: "Checking devbox availability",
        command: "bash",
        args: ["-lc", "command -v devbox >/dev/null 2>&1"],
        errorCode: "devbox_not_found",
        errorMessage: "Devbox is not installed or not available on PATH",
        captureStdout: false,
      });

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

      setStep(record, this.maxLogEntries, "devbox_up", "Starting devbox");
      await this.runCmd(record, executor, {
        step: "devbox_up",
        label: "Running devbox up",
        command: "devbox",
        args: buildDevboxArgs("up", {
          devcontainerSubpath: record.job.config.devcontainerSubpath,
          devboxTemplate: record.job.config.devboxTemplate,
          githubUser: record.job.config.githubUser,
        }),
        cwd: targetDirectory,
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
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

      const resolvedDirectory = status.workdir?.trim();
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include a workdir value",
        );
      }

      const resolvedPort = status.sshPort ?? status.port ?? getPublishedPortFallback(status);
      if (!resolvedPort) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include SSH port information",
        );
      }

      const resolvedUsername =
        status.sshUser?.trim() ||
        devboxCredential.username?.trim() ||
        status.remoteUser?.trim() ||
        server.username.trim();
      if (!resolvedUsername) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include SSH username information",
        );
      }

      const resolvedPassword = status.password?.trim() || devboxCredential.password?.trim();
      if (!resolvedPassword) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "Could not determine the devbox SSH password from devbox status or credential file",
        );
      }

      const serverSettings: ServerSettings = {
        agent: {
          provider: record.job.config.provider,
          transport: "ssh",
          hostname: server.address,
          port: resolvedPort,
          username: resolvedUsername,
          password: resolvedPassword,
        },
      };

      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Resolved devbox SSH endpoint ${resolvedUsername}@${server.address}:${resolvedPort}`,
        "devbox_status",
      );

      setStep(record, this.maxLogEntries, "create_workspace", "Creating workspace record");
      // Always create a new workspace. Workspaces are identified by their
      // unique ID, not by directory+server_fingerprint. Two separate
      // devbox containers may share the same directory path and SSH
      // fingerprint but represent distinct workspaces.
      const now = new Date().toISOString();
      const workspace = {
        id: crypto.randomUUID(),
        name: record.job.config.name,
        directory: resolvedDirectory,
        serverSettings,
        createdAt: now,
        updatedAt: now,
        sourceDirectory: record.job.state.targetDirectory,
        sshServerId: record.job.config.sshServerId,
        repoUrl: record.job.config.repoUrl,
        basePath: record.job.config.basePath,
        devcontainerSubpath: record.job.config.devcontainerSubpath,
        provider: record.job.config.provider,
      };
      await createWorkspace(workspace);
      createdWorkspaceId = workspace.id;
      this.updateState(record, {
        workspaceId: workspace.id,
        workspaceAction: "created",
      });
      appendSystemLog(record, this.maxLogEntries, `Created workspace ${workspace.name}`, "create_workspace");

      setStep(record, this.maxLogEntries, "test_connection", "Testing workspace connection");
      const connectionResult = await backendManager.testConnection(serverSettings, resolvedDirectory);
      if (!connectionResult.success) {
        throw new ProvisioningFailedError(
          "connection_test_failed",
          "test_connection",
          connectionResult.error ?? "Workspace connection test failed",
        );
      }

      setStep(record, this.maxLogEntries, "workspace_ready");
      const completedAt = new Date().toISOString();
      record.job.state = {
        ...record.job.state,
        status: "completed",
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(
        record,
        this.maxLogEntries,
        record.job.state.workspaceAction === "reused"
          ? `Workspace connection test succeeded. Existing workspace ${record.job.config.name} is ready.`
          : `Workspace connection test succeeded. Workspace ${record.job.config.name} was created successfully and is ready.`,
        "workspace_ready",
      );
      emitJobCompleted(record.job);
      this.scheduleCleanup(record);
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
          await deleteWorkspace(createdWorkspaceId);
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

      const completedAt = new Date().toISOString();
      record.job.state = {
        ...record.job.state,
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
      this.scheduleCleanup(record);
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
      }

      const { server, executor } = await sshServerManager.getCommandExecutor(
        record.job.config.sshServerId,
        password,
      );

      this.updateState(record, {
        targetDirectory,
        workspaceId,
        workspaceAction: "reused",
      });

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.runCmd(record, executor, {
        step: "verify_devbox",
        label: "Checking devbox availability",
        command: "bash",
        args: ["-lc", "command -v devbox >/dev/null 2>&1"],
        errorCode: "devbox_not_found",
        errorMessage: "Devbox is not installed or not available on PATH",
        captureStdout: false,
      });

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

      setStep(record, this.maxLogEntries, action.step, action.progressLabel);
      await this.runCmd(record, executor, {
        step: action.step,
        label: action.commandLabel,
        command: "devbox",
        args: buildDevboxArgs(action.step === "devbox_rebuild" ? "rebuild" : "up", {
          devcontainerSubpath,
          githubUser: record.job.config.githubUser,
        }),
        cwd: targetDirectory,
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
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

      const resolvedDirectory = status.workdir?.trim();
      if (!resolvedDirectory) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include a workdir value",
        );
      }

      const resolvedPort = status.sshPort ?? status.port ?? getPublishedPortFallback(status);
      if (!resolvedPort) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include SSH port information",
        );
      }

      const resolvedUsername =
        status.sshUser?.trim() ||
        devboxCredential.username?.trim() ||
        status.remoteUser?.trim() ||
        server.username.trim();
      if (!resolvedUsername) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "devbox status did not include SSH username information",
        );
      }

      const resolvedPassword = status.password?.trim() || devboxCredential.password?.trim();
      if (!resolvedPassword) {
        throw new ProvisioningFailedError(
          "invalid_devbox_status",
          "devbox_status",
          "Could not determine the devbox SSH password from devbox status or credential file",
        );
      }

      const serverSettings: ServerSettings = {
        agent: {
          provider: record.job.config.provider,
          transport: "ssh",
          hostname: server.address,
          port: resolvedPort,
          username: resolvedUsername,
          password: resolvedPassword,
        },
      };

      this.updateState(record, { resolvedDirectory, serverSettings });
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Resolved devbox SSH endpoint ${resolvedUsername}@${server.address}:${resolvedPort}`,
        "devbox_status",
      );

      // Update the existing workspace's server settings (port/password may change after rebuild)
      const updatedWorkspace = await updateWorkspace(workspaceId, {
        serverSettings,
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
      const connectionResult = await backendManager.testConnection(serverSettings, resolvedDirectory);
      if (!connectionResult.success) {
        throw new ProvisioningFailedError(
          "connection_test_failed",
          "test_connection",
          connectionResult.error ?? "Workspace connection test failed",
        );
      }

      setStep(record, this.maxLogEntries, "workspace_ready");
      const completedAt = new Date().toISOString();
      record.job.state = {
        ...record.job.state,
        status: "completed",
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(
        record,
        this.maxLogEntries,
        action.completionMessage,
        "workspace_ready",
      );
      emitJobCompleted(record.job);
      this.scheduleCleanup(record);
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
      record.job.state = {
        ...record.job.state,
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
      this.scheduleCleanup(record);
    }
  }

  private async runServerAriseJob(
    record: ProvisioningJobRecord,
    password: string | undefined,
  ): Promise<void> {
    try {
      const { executor } = await sshServerManager.getCommandExecutor(
        record.job.config.sshServerId,
        password,
      );

      setStep(record, this.maxLogEntries, "verify_devbox", "Checking for devbox");
      await this.runCmd(record, executor, {
        step: "verify_devbox",
        label: "Checking devbox availability",
        command: "bash",
        args: ["-lc", "command -v devbox >/dev/null 2>&1"],
        errorCode: "devbox_not_found",
        errorMessage: "Devbox is not installed or not available on PATH",
        captureStdout: false,
      });

      setStep(record, this.maxLogEntries, "devbox_arise", "Running devbox arise");
      await this.runCmd(record, executor, {
        step: "devbox_arise",
        label: "Running devbox arise",
        command: "devbox",
        args: ["arise"],
        timeout: DEVBOX_UP_TIMEOUT_MS,
        streamOutput: true,
        errorCode: "devbox_arise_failed",
        errorMessage: "Failed to run devbox arise",
      });

      setStep(record, this.maxLogEntries, "arise_complete");
      const completedAt = new Date().toISOString();
      record.job.state = {
        ...record.job.state,
        status: "completed",
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(
        record,
        this.maxLogEntries,
        `Devbox arise completed successfully for ${record.job.config.name}.`,
        "arise_complete",
      );
      emitJobCompleted(record.job);
      this.scheduleCleanup(record);
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
      record.job.state = {
        ...record.job.state,
        status: cancelled ? "cancelled" : "failed",
        error: failure,
        completedAt,
        updatedAt: completedAt,
      };
      appendSystemLog(record, this.maxLogEntries, failure.message, failure.step);
      if (cancelled) {
        emitJobCancelled(record.job);
      } else {
        emitJobFailed(record.job, failure);
      }
      this.scheduleCleanup(record);
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

  private throwIfCancelled(record: ProvisioningJobRecord): void {
    if (record.abortController.signal.aborted) {
      throw new ProvisioningCancelledError("Provisioning job was cancelled");
    }
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
  }

  private scheduleCleanup(record: ProvisioningJobRecord): void {
    if (record.cleanupTimer) {
      clearTimeout(record.cleanupTimer);
    }
    record.cleanupTimer = setTimeout(() => {
      this.jobs.delete(record.job.config.id);
    }, this.jobRetentionMs);
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
