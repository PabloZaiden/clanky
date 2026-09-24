import { z } from "zod";
import { AgentProviderSchema } from "./workspace";
import { SshCredentialTokenSchema } from "./ssh-server";
import { ExecutionHostRefSchema } from "./execution-host";
import {
  isIncompleteGitHubRepositoryUrl,
  isValidWorkerHostAddress,
  PROVISIONING_WORKER_ENROLLMENT_ROUTES,
} from "@/shared";
import { ControllerRelayNameSchema } from "./mesh-relay";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const ProvisioningJobModeSchema = z.enum(["provision", "rebuild", "restart", "arise"]);
export const ProvisioningTransportSchema = z.enum(["ssh", "worker"]);
export const ProvisioningWorkerEnrollmentRouteSchema = z.enum(
  PROVISIONING_WORKER_ENROLLMENT_ROUTES,
);

export const CreateProvisioningJobRequestSchema = z.object({
  name: RequiredTrimmedStringSchema,
  executionHost: ExecutionHostRefSchema.optional(),
  workspaceWorkerEnrollmentId: RequiredTrimmedStringSchema.optional(),
  transport: ProvisioningTransportSchema.optional(),
  workerEnrollmentRoute: ProvisioningWorkerEnrollmentRouteSchema.optional(),
  workerRelayName: ControllerRelayNameSchema.optional(),
  workerHostAddress: z.string()
    .trim()
    .nullable()
    .optional()
    .refine((value) => value === null || value === undefined || isValidWorkerHostAddress(value), {
      message: "worker host address must not contain spaces and must be a valid host value",
    }),
  workerHostAddressManual: z.boolean().default(false),
  repoUrl: z.string().trim(),
  basePath: z.string().trim(),
  devcontainerSubpath: z.string().trim().nullable(),
  devboxTemplate: z.string().trim().nullish(),
  githubUser: z.string().trim().nullish(),
  provider: AgentProviderSchema,
  credentialToken: SshCredentialTokenSchema.nullable(),
  mode: ProvisioningJobModeSchema,
  createNewRepository: z.boolean().default(false),
  /** For rebuild/restart: directory on the host where the repo lives */
  targetDirectory: z.string().trim().nullable(),
  /** For rebuild/restart: existing workspace ID */
  workspaceId: z.string().trim().nullable(),
}).refine((data) => {
  if (
    data.workerRelayName
    && (data.transport !== "worker" || data.workerEnrollmentRoute !== "relay")
  ) {
    return false;
  }
  const targetCount = [
    Boolean(data.executionHost),
    Boolean(data.workspaceWorkerEnrollmentId),
  ].filter(Boolean).length;
  if (targetCount !== 1) {
    return false;
  }
  if (data.workspaceWorkerEnrollmentId && data.mode !== "provision") {
    return false;
  }
  if (data.transport === "worker" && data.workspaceWorkerEnrollmentId) {
    return false;
  }
  if (data.mode === "provision") {
    if (data.createNewRepository) {
      return data.basePath.length > 0 && (data.devboxTemplate ?? "").length > 0;
    }
    return data.repoUrl.length > 0
      && !isIncompleteGitHubRepositoryUrl(data.repoUrl)
      && data.basePath.length > 0;
  }
  if (data.mode === "arise") {
    return true;
  }
  return (data.targetDirectory ?? "").length > 0
    && (data.workspaceId ?? "").length > 0;
}, {
  message: "Provisioning requires one execution host or dedicated worker enrollment, a relay name only with worker relay transport, and a valid target for the selected mode.",
});

export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;
