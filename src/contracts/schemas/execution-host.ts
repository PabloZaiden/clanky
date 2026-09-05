/**
 * Zod schemas for transport-neutral execution host contracts.
 */

import { z } from "zod";
import {
  EXECUTION_HOST_AVAILABILITIES,
  EXECUTION_HOST_CAPABILITY_IDS,
  EXECUTION_HOST_KINDS,
} from "@/shared/execution-host";
import { ModelConfigSchema } from "./model";

const RequiredIdSchema = z.string().trim().min(1);
const CapabilityVersionSchema = z.number().int().min(1);

export const ExecutionHostKindSchema = z.enum(EXECUTION_HOST_KINDS);

export const ExecutionHostRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    nodeId: RequiredIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("mesh"),
    nodeId: RequiredIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("ssh"),
    serverId: RequiredIdSchema,
  }).strict(),
]);

export const ExecutionHostCapabilityIdSchema = z.enum(
  EXECUTION_HOST_CAPABILITY_IDS,
);

export const ExecutionHostCapabilitiesSchema = z.object(
  Object.fromEntries(
    EXECUTION_HOST_CAPABILITY_IDS.map((capability) => [
      capability,
      CapabilityVersionSchema.optional(),
    ]),
  ) as Record<
    typeof EXECUTION_HOST_CAPABILITY_IDS[number],
    z.ZodOptional<typeof CapabilityVersionSchema>
  >,
).strict();

export const ExecutionNodeConfigurationSchema = z.object({
  name: RequiredIdSchema,
  endpoint: z.string().nullable(),
  repositoriesBasePath: z.string().nullable(),
  preferredModel: ModelConfigSchema.nullable().default(null),
  acceptRemoteExecution: z.boolean(),
  capabilities: ExecutionHostCapabilitiesSchema,
  revision: z.number().int().min(1),
}).strict();

export const ExecutionHostAvailabilitySchema = z.enum(
  EXECUTION_HOST_AVAILABILITIES,
);

export const ExecutionHostAccessRequirementSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({
      kind: z.literal("sshCredentials"),
      serverId: RequiredIdSchema,
      methods: z.array(z.enum(["agent", "password"])).min(1),
    }).strict(),
  ],
);

export const ExecutionHostBindingSchema = z.object({
  host: ExecutionHostRefSchema,
  targetKey: RequiredIdSchema,
  revision: z.number().int().min(1),
}).strict();

export const ExecutionHostDescriptorSchema = z.object({
  ref: ExecutionHostRefSchema,
  targetKey: RequiredIdSchema,
  name: RequiredIdSchema,
  endpoint: z.string().nullable(),
  repositoriesBasePath: z.string().nullable(),
  preferredModel: ModelConfigSchema.nullable(),
  configurationRevision: z.number().int().min(1),
  availability: ExecutionHostAvailabilitySchema,
  accessRequirement: ExecutionHostAccessRequirementSchema,
  acceptRemoteExecution: z.boolean(),
  capabilities: ExecutionHostCapabilitiesSchema,
  revision: z.number().int().min(1),
  isPrivate: z.boolean().optional(),
}).strict();

export const UpdateExecutionHostConfigurationSchema = z.object({
  repositoriesBasePath: z.string().trim().min(1).nullable(),
  preferredModel: ModelConfigSchema.nullable(),
  expectedRevision: z.number().int().min(1),
}).strict();

export const ExecutionHostWorkingDirectorySchema = z.object({
  directory: z.string().trim().min(1),
  configured: z.boolean(),
}).strict();

export type ExecutionHostRefInput = z.infer<typeof ExecutionHostRefSchema>;
export type ExecutionNodeConfigurationInput = z.infer<
  typeof ExecutionNodeConfigurationSchema
>;
export type ExecutionHostBindingInput = z.infer<typeof ExecutionHostBindingSchema>;
export type ExecutionHostDescriptorInput = z.infer<typeof ExecutionHostDescriptorSchema>;
export type UpdateExecutionHostConfigurationRequest = z.infer<
  typeof UpdateExecutionHostConfigurationSchema
>;
export type ExecutionHostWorkingDirectory = z.infer<
  typeof ExecutionHostWorkingDirectorySchema
>;
