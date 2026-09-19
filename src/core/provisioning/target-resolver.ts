import { posix as pathPosix } from "node:path";
import type {
  ExecutionHostBinding,
  ProvisioningJob,
  ProvisioningJobMode,
  ProvisioningTransport,
} from "@/shared";
import { isValidWorkerHostAddress } from "@/shared";
import { getWorkspace } from "../../persistence/workspaces";
import { controllerRelayService } from "../controller-relay-service";
import { executionHostDiscoveryService } from "../execution-host-discovery-service";
import { executionHostService } from "../execution-host-service";
import { workspaceWorkerEnrollmentService } from "../workspace-worker-enrollment-service";
import { ProvisioningFailedError } from "./errors";
import type { StartProvisioningJobOptions } from "./types";
import { extractRepoName } from "./repo-utils";

export interface ProvisioningTargetResolution {
  mode: ProvisioningJobMode;
  transport: ProvisioningTransport;
  executionHostBinding: ExecutionHostBinding;
  ownership: ProvisioningTargetOwnership;
  workspaceWorkerEnrollmentId?: string;
  existingWorkerEnrollmentId?: string;
  workerEnrollmentRoute?: "direct" | "relay";
  workerHostAddress?: string;
}

export interface ProvisioningTargetOwnership {
  executionHost: "external" | "reused" | "claimed";
  workspace: "new" | "reused" | "none";
  workerEnrollment: "new" | "reused" | "claimed" | "none";
}

export function inferProvisioningTargetOwnership(
  config: ProvisioningJob["config"],
): ProvisioningTargetOwnership {
  const mode = config.mode ?? "provision";
  return {
    executionHost: config.workspaceWorkerEnrollmentId
      ? "claimed"
      : (mode === "rebuild" || mode === "restart") && config.workspaceId
        ? "reused"
        : "external",
    workspace: mode === "provision"
      ? "new"
      : mode === "arise"
        ? "none"
        : "reused",
    workerEnrollment: config.workspaceWorkerEnrollmentId
      ? "claimed"
      : (mode === "rebuild" || mode === "restart") && config.workerEnrollmentId
        ? "reused"
        : config.transport === "worker"
          ? "new"
          : "none",
  };
}

export function normalizeOptionalValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function validateWorkerHostAddress(value: string | undefined): string {
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

export function validateNewRepositoryFolderName(name: string): void {
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

export function getProvisioningTargetKey(
  config: ProvisioningJob["config"],
): string | null {
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

export async function resolveProvisioningTarget(
  userId: string,
  options: StartProvisioningJobOptions,
  jobId: string,
): Promise<ProvisioningTargetResolution> {
  const mode = options.mode ?? "provision";
  const transport = resolveProvisioningTransport(userId, options, mode);
  if (transport === "worker" && options.workspaceWorkerEnrollmentId) {
    throw new ProvisioningFailedError(
      "invalid_execution_target",
      "verify_devbox",
      "Worker transport cannot use an existing dedicated worker enrollment as its provisioning target",
    );
  }

  const executionHostResolution = await resolveProvisioningExecutionHostBinding(
    userId,
    options,
  );
  const executionHostBinding = executionHostResolution.binding;
  if (mode === "arise") {
    executionHostService.requireBindingCapability(
      executionHostBinding,
      "devboxLifecycle",
      userId,
    );
  }

  const existingWorkerEnrollment = transport === "worker"
    && (mode === "rebuild" || mode === "restart")
    && options.workspaceId
    ? workspaceWorkerEnrollmentService.getByWorkspace(userId, options.workspaceId)
    : null;
  const workerEnrollmentRoute = transport === "worker"
    ? existingWorkerEnrollment?.worker?.route.kind
      ?? controllerRelayService.getDedicatedWorkerEnrollmentRoute()
    : undefined;
  const workerHostAddress = transport === "worker"
    && mode === "provision"
    && workerEnrollmentRoute !== "relay"
    ? await resolveWorkerHostAddress(
        userId,
        executionHostBinding,
        options,
        jobId,
        options.workerHostAddressManual === true,
      )
    : undefined;

  return {
    mode,
    transport,
    executionHostBinding,
    ownership: {
      executionHost: executionHostResolution.ownership,
      workspace: mode === "provision"
        ? "new"
        : mode === "arise"
          ? "none"
          : "reused",
      workerEnrollment: options.workspaceWorkerEnrollmentId
        ? "claimed"
        : existingWorkerEnrollment
          ? "reused"
          : transport === "worker"
            ? "new"
            : "none",
    },
    ...(executionHostResolution.workspaceWorkerEnrollmentId
      ? { workspaceWorkerEnrollmentId: executionHostResolution.workspaceWorkerEnrollmentId }
      : {}),
    ...(existingWorkerEnrollment
      ? { existingWorkerEnrollmentId: existingWorkerEnrollment.enrollment.id }
      : {}),
    ...(workerEnrollmentRoute ? { workerEnrollmentRoute } : {}),
    ...(workerHostAddress ? { workerHostAddress } : {}),
  };
}

async function resolveProvisioningExecutionHostBinding(
  userId: string,
  options: StartProvisioningJobOptions,
): Promise<{
  binding: ExecutionHostBinding;
  ownership: ProvisioningTargetOwnership["executionHost"];
  workspaceWorkerEnrollmentId?: string;
}> {
  if (options.workspaceWorkerEnrollmentId) {
    if ((options.mode ?? "provision") !== "provision") {
      throw new ProvisioningFailedError(
        "invalid_execution_target",
        "verify_devbox",
        "Dedicated worker enrollments can only create a new workspace",
      );
    }
    const binding = workspaceWorkerEnrollmentService.getExecutionHostBinding(
      userId,
      options.workspaceWorkerEnrollmentId,
    );
    executionHostService.requireBindingCapability(
      binding,
      "provisioning",
      userId,
    );
    return {
      binding,
      ownership: "claimed",
      workspaceWorkerEnrollmentId: options.workspaceWorkerEnrollmentId,
    };
  }
  if (
    (options.mode === "rebuild" || options.mode === "restart")
    && options.workspaceId
  ) {
    const workspace = await getWorkspace(options.workspaceId);
    if (workspace?.provisioningHostBinding) {
      executionHostService.requireBindingCapability(
        workspace.provisioningHostBinding,
        "provisioning",
        userId,
      );
      return {
        binding: workspace.provisioningHostBinding,
        ownership: "reused",
      };
    }
  }
  if (!options.executionHost) {
    throw new ProvisioningFailedError(
      "missing_execution_host",
      "verify_devbox",
      "Provisioning requires an execution host",
    );
  }
  await executionHostService.requireCapability(
    options.executionHost,
    "provisioning",
    userId,
  );
  return {
    binding: executionHostService.getBinding(options.executionHost, userId),
    ownership: "external",
  };
}

export function claimProvisioningTarget(
  userId: string,
  target: ProvisioningTargetResolution,
  jobId: string,
): ExecutionHostBinding {
  if (!target.workspaceWorkerEnrollmentId) {
    return target.executionHostBinding;
  }
  return workspaceWorkerEnrollmentService.claimForProvisioning(
    userId,
    target.workspaceWorkerEnrollmentId,
    jobId,
  );
}

export function releaseProvisioningTargetClaim(
  userId: string,
  enrollmentId: string,
  jobId: string,
): boolean {
  return workspaceWorkerEnrollmentService.releaseProvisioningClaim(
    userId,
    enrollmentId,
    jobId,
  );
}

function resolveProvisioningTransport(
  userId: string,
  options: StartProvisioningJobOptions,
  mode: ProvisioningJobMode,
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
  if (
    options.workspaceId
    && workspaceWorkerEnrollmentService.getByWorkspace(userId, options.workspaceId)
  ) {
    return "worker";
  }
  return "ssh";
}

async function resolveWorkerHostAddress(
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
