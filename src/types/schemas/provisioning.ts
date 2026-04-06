import { z } from "zod";
import { AgentProviderSchema } from "./workspace";
import { SshCredentialTokenSchema } from "./ssh-server";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const ProvisioningJobModeSchema = z.enum(["provision", "rebuild", "restart", "arise"]).default("provision");

export const CreateProvisioningJobRequestSchema = z.object({
  name: RequiredTrimmedStringSchema,
  sshServerId: RequiredTrimmedStringSchema,
  repoUrl: z.string().trim().optional().default(""),
  basePath: z.string().trim().optional().default(""),
  devcontainerSubpath: z.string().trim().optional(),
  provider: AgentProviderSchema.default("copilot"),
  credentialToken: SshCredentialTokenSchema.optional(),
  mode: ProvisioningJobModeSchema,
  /** For rebuild/restart: directory on the host where the repo lives */
  targetDirectory: z.string().trim().optional(),
  /** For rebuild/restart: existing workspace ID */
  workspaceId: z.string().trim().optional(),
}).refine((data) => {
  if (data.mode === "provision") {
    return data.repoUrl.length > 0 && data.basePath.length > 0;
  }
  if (data.mode === "arise") {
    return true;
  }
  return (data.targetDirectory?.length ?? 0) > 0 && (data.workspaceId?.length ?? 0) > 0;
}, {
  message: "provision mode requires repoUrl and basePath; rebuild/restart mode requires targetDirectory and workspaceId; arise mode only requires the server context",
});

export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;
