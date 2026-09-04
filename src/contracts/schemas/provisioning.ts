import { z } from "zod";
import { AgentProviderSchema } from "./workspace";
import { SshCredentialTokenSchema } from "./ssh-server";
import { ExecutionHostRefSchema } from "./execution-host";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const ProvisioningJobModeSchema = z.enum(["provision", "rebuild", "restart", "arise"]);

export const CreateProvisioningJobRequestSchema = z.object({
  name: RequiredTrimmedStringSchema,
  sshServerId: RequiredTrimmedStringSchema.nullish(),
  executionNodeId: RequiredTrimmedStringSchema.nullish(),
  executionHost: ExecutionHostRefSchema.nullish(),
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
  const targetCount = [
    Boolean(data.executionHost),
    Boolean(data.sshServerId),
    Boolean(data.executionNodeId),
  ].filter(Boolean).length;
  if (data.mode === "provision") {
    if (targetCount !== 1) {
      return false;
    }
    if (data.createNewRepository) {
      return data.basePath.length > 0 && (data.devboxTemplate ?? "").length > 0;
    }
    return data.repoUrl.length > 0 && data.basePath.length > 0;
  }
  if (data.mode === "arise") {
    return targetCount === 1;
  }
  return targetCount === 1
    && (data.targetDirectory ?? "").length > 0
    && (data.workspaceId ?? "").length > 0;
}, {
  message: "provision mode requires one execution host plus repoUrl and basePath, or basePath and devboxTemplate when createNewRepository is true; rebuild/restart mode requires one execution host, targetDirectory, and workspaceId; arise mode requires one execution host",
});

export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;
