import { posix as pathPosix } from "node:path";
import { closeCommandExecutor, type CommandExecutor, type CommandResult } from "../command-executor";
import { GitService } from "../git";
import { executionHostService } from "../execution-host-service";
import type {
  DevboxStatusResult,
  ExecutionHostBinding,
  ProvisioningJob,
} from "@/shared";
import { getRegisteredSshServerId } from "@/shared/execution-host";
import { getSshServerConfig } from "../../persistence/ssh-servers";
import type { WorkspaceSshTargetInput } from "../../persistence/workspace-execution-targets";
import { GIT_CLONE_TIMEOUT_MS } from "./constants";
import { ProvisioningCancelledError, ProvisioningFailedError } from "./errors";
import {
  parseDevboxCredentialContent,
  parseDevboxStatusOutput,
} from "./devbox-utils";
import {
  appendSystemLog,
} from "./job-logger";
import {
  validateNewRepositoryFolderName,
} from "./target-resolver";
import {
  runProvisioningCommand,
  type RunCommandOptions,
} from "./command-runner";
import { extractRepoName, normalizeRepoUrl } from "./repo-utils";
import type { ProvisioningJobRecord } from "./types";

export interface ProvisioningDevboxCredential {
  password?: string;
}

type ProvisioningCommandRunner = (
  record: ProvisioningJobRecord,
  executor: CommandExecutor,
  options: RunCommandOptions,
  maxLogEntries: number,
) => Promise<CommandResult>;

export class ProvisioningRemoteExecutor {
  constructor(
    private readonly maxLogEntries: number,
    private readonly commandRunner: ProvisioningCommandRunner = runProvisioningCommand,
  ) {}

  async acquire(
    record: ProvisioningJobRecord,
    password: string | undefined,
    directory: string,
  ): Promise<CommandExecutor> {
    const binding = record.job.config.executionHostBinding;
    if (!binding) {
      throw new ProvisioningFailedError(
        "missing_execution_host",
        "verify_devbox",
        "Provisioning requires an execution host",
      );
    }
    let executor: CommandExecutor | undefined;
    try {
      executor = await executionHostService.getCommandExecutor(binding, {
        operationId: `provisioning:${record.job.config.id}`,
        directory,
        provider: record.job.config.provider,
        localUserId: record.owner.id,
        sshPassword: password,
      });
      // A separate read-only probe establishes the connection boundary before job commands.
      const probe = await executor.exec(
        "true",
        [],
        { cwd: "/", timeout: 5000, signal: record.abortController.signal, logFailures: false },
      );
      if (!probe.success) {
        throw new ProvisioningFailedError(
          "provisioning_connection_failed", "verify_devbox",
          probe.stderr || "The execution host did not accept the connection probe.",
        );
      }
      const ownedExecutor = executor;
      record.attempt?.registerCleanup("Execution connection", () => closeCommandExecutor(ownedExecutor));
      return executor;
    } catch (error) {
      if (executor) closeCommandExecutor(executor);
      if (record.abortController.signal.aborted) {
        throw new ProvisioningCancelledError("Provisioning job was cancelled", { cause: error });
      }
      const detail = error instanceof Error ? error.message : String(error);
      appendSystemLog(record, this.maxLogEntries, detail, "verify_devbox");
      throw new ProvisioningFailedError(
        "provisioning_connection_failed", "verify_devbox",
        "Could not connect to the execution host.",
        { cause: error, details: { executionRequestDispatched: false } },
      );
    }
  }

  async acquireForRecovery(
    job: ProvisioningJob,
    userId: string,
    directory: string,
  ): Promise<CommandExecutor> {
    return await executionHostService.getCommandExecutor(
      job.config.executionHostBinding,
      {
        operationId: `provisioning:${job.config.id}`,
        directory,
        provider: job.config.provider,
        localUserId: userId,
      },
    );
  }

  async prepareRepository(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
  ): Promise<string> {
    const config = record.job.config;
    if (config.createNewRepository) {
      validateNewRepositoryFolderName(config.name);
    }
    const targetDirectory = config.createNewRepository
      ? pathPosix.join(config.basePath, config.name)
      : pathPosix.join(config.basePath, extractRepoName(config.repoUrl ?? ""));
    const targetExists = await executor.directoryExists(targetDirectory);
    if (config.createNewRepository) {
      if (!config.devboxTemplate) {
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
      await this.run(record, executor, {
        step: "clone_repo",
        label: `Creating repository directory ${targetDirectory}`,
        command: "mkdir",
        args: ["-p", targetDirectory],
      });
      await this.run(record, executor, {
        step: "clone_repo",
        label: `Initializing git repository in ${targetDirectory}`,
        command: "git",
        args: ["init", "-b", "main"],
        cwd: targetDirectory,
        errorCode: "git_init_failed",
        errorMessage: "Failed to initialize git repository",
      });
      return targetDirectory;
    }

    if (!targetExists) {
      await this.run(record, executor, {
        step: "clone_repo",
        label: `Cloning repository into ${targetDirectory}`,
        command: "git",
        args: ["clone", config.repoUrl ?? "", targetDirectory],
        timeout: GIT_CLONE_TIMEOUT_MS,
        streamOutput: true,
        longRunning: true,
        errorCode: "clone_failed",
        errorMessage: "Failed to clone repository",
      });
      return targetDirectory;
    }

    const git = GitService.withExecutor(executor);
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

    if (
      normalizeRepoUrl(remoteUrlResult.stdout)
      !== normalizeRepoUrl(config.repoUrl ?? "")
    ) {
      throw new ProvisioningFailedError(
        "clone_conflict",
        "clone_repo",
        `Target directory already exists with a different origin remote: ${targetDirectory}`,
      );
    }

    appendSystemLog(
      record,
      this.maxLogEntries,
      `Reusing existing checkout at ${targetDirectory}`,
      "clone_repo",
    );
    return targetDirectory;
  }

  async prepareBaseDirectory(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
  ): Promise<void> {
    await this.run(record, executor, {
      step: "prepare_directory",
      label: `Ensuring base path ${record.job.config.basePath}`,
      command: "mkdir",
      args: ["-p", record.job.config.basePath],
    });
  }

  async readDevboxStatus(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    cwd: string,
    options: { label?: string; timeout?: number; signal?: AbortSignal } = {},
  ): Promise<DevboxStatusResult> {
    const result = await this.run(record, executor, {
      step: "devbox_status",
      label: options.label ?? "Reading devbox status",
      command: "devbox",
      args: ["status"],
      cwd,
      errorCode: "invalid_devbox_status",
      errorMessage: "Failed to read devbox status",
      captureStdout: false,
      timeout: options.timeout,
      signal: options.signal,
    });
    return parseDevboxStatusOutput(result.stdout);
  }

  async confirmLifecycleRecovery(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
    directory: string,
  ): Promise<DevboxStatusResult> {
    const deadline = performance.now() + 20_000;
    let lastError: unknown;
    while (performance.now() < deadline) {
      this.throwIfCancelled(record);
      const controller = new AbortController();
      const budget = Math.min(5000, deadline - performance.now());
      const timer = setTimeout(() => controller.abort(), Math.max(1, budget));
      try {
        const status = await this.readDevboxStatus(record, executor, directory, {
          label: "Checking workspace recovery", timeout: budget, signal: controller.signal,
        });
        if (status.running) return status;
      } catch (error) {
        if (!(error instanceof ProvisioningFailedError)
          || !["provisioning_connection_failed", "provisioning_execution_unconfirmed",
            "provisioning_execution_interrupted"].includes(error.code)) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      const remaining = deadline - performance.now();
      if (remaining > 0) await Bun.sleep(Math.min(1000, remaining));
    }
    throw new ProvisioningFailedError(
      "provisioning_execution_unconfirmed", "devbox_status",
      "Workspace recovery could not be confirmed.",
      { cause: lastError },
    );
  }

  async readDevboxCredential(
    executor: CommandExecutor,
    status: DevboxStatusResult,
  ): Promise<ProvisioningDevboxCredential> {
    if (!status.password && status.hasCredentialFile && status.credentialPath) {
      const credentialContent = await executor.readFile(status.credentialPath);
      if (credentialContent) {
        return parseDevboxCredentialContent(credentialContent);
      }
    }
    return {};
  }

  async verifyDevbox(
    record: ProvisioningJobRecord,
    executor: CommandExecutor,
  ): Promise<void> {
    await this.run(record, executor, {
      step: "verify_devbox",
      label: "Checking Devbox availability",
      command: "devbox",
      args: ["--help"],
      errorCode: "devbox_not_found",
      errorMessage: "Devbox is not installed or not available on PATH",
      captureStdout: false,
    });
  }

  async buildWorkspaceSshTarget(
    binding: ExecutionHostBinding,
    status: DevboxStatusResult,
    credential: ProvisioningDevboxCredential,
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

  async run(
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

  private throwIfCancelled(record: ProvisioningJobRecord): void {
    if (record.abortController.signal.aborted) {
      throw new ProvisioningCancelledError("Provisioning job was cancelled");
    }
  }
}
