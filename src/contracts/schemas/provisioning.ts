import { z } from "zod";
import { AgentProviderSchema } from "./workspace";
import { SshCredentialTokenSchema } from "./ssh-server";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const ProvisioningJobModeSchema = z.enum(["provision", "rebuild", "restart", "arise"]);

export const CreateProvisioningJobRequestSchema = z.object({
  name: RequiredTrimmedStringSchema,
  sshServerId: RequiredTrimmedStringSchema.nullish(),
  executionNodeId: RequiredTrimmedStringSchema.nullish(),
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
  if (data.mode === "provision") {
    if ((!data.sshServerId && !data.executionNodeId) || (data.sshServerId && data.executionNodeId)) {
      return false;
    }
    if (data.createNewRepository) {
      return data.basePath.length > 0 && (data.devboxTemplate ?? "").length > 0;
    }
    return data.repoUrl.length > 0 && data.basePath.length > 0;
  }
  if (data.mode === "arise") {
    return Boolean(data.sshServerId) && !data.executionNodeId;
  }
  return Boolean(data.sshServerId)
    && !data.executionNodeId
    && (data.targetDirectory ?? "").length > 0
    && (data.workspaceId ?? "").length > 0;
}, {
  message: "provision mode requires an SSH server or stdio execution node plus repoUrl and basePath, or basePath and devboxTemplate when createNewRepository is true; rebuild/restart mode requires targetDirectory and workspaceId; arise mode only requires the server context",
});

export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;
