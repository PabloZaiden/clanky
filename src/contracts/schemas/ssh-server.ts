/**
 * Zod schemas for standalone SSH server and credential APIs.
 */

import { z } from "zod";
import { SshConnectionModeSchema } from "./ssh-session";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const SshKeyAlgorithmSchema = z.literal("RSA-OAEP-256");

export const CreateSshServerRequestSchema = z.object({
  name: RequiredTrimmedStringSchema,
  address: RequiredTrimmedStringSchema,
  username: RequiredTrimmedStringSchema,
  repositoriesBasePath: z.string().trim().nullable(),
});

export const UpdateSshServerRequestSchema = z.object({
  name: RequiredTrimmedStringSchema.optional(),
  address: RequiredTrimmedStringSchema.optional(),
  username: RequiredTrimmedStringSchema.optional(),
  repositoriesBasePath: z.string().trim().nullish(),
  isPrivate: z.boolean().optional(),
}).refine((value) => {
  return value.name !== undefined
    || value.address !== undefined
    || value.username !== undefined
    || value.repositoriesBasePath !== undefined
    || value.isPrivate !== undefined;
}, {
  message: "at least one field must be provided",
});

export const SshServerEncryptedCredentialSchema = z.object({
  algorithm: SshKeyAlgorithmSchema,
  fingerprint: RequiredTrimmedStringSchema,
  version: z.number().int().min(1, "version must be at least 1"),
  ciphertext: RequiredTrimmedStringSchema,
});

export const SshCredentialExchangeRequestSchema = z.object({
  encryptedCredential: SshServerEncryptedCredentialSchema,
});

export const SshCredentialTokenSchema = RequiredTrimmedStringSchema;

export const CreateSshServerSessionRequestSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  credentialToken: SshCredentialTokenSchema.nullable(),
  connectionMode: SshConnectionModeSchema,
  useTmux: z.boolean().optional(),
});

export const DeleteSshServerSessionRequestSchema = z.object({
  credentialToken: SshCredentialTokenSchema.nullable(),
});

export const CheckSshServerPrerequisitesRequestSchema = z.object({
  credentialToken: SshCredentialTokenSchema.nullable(),
});

export const GetDevboxTemplatesRequestSchema = z.object({
  credentialToken: SshCredentialTokenSchema.nullable(),
});

export const CreateVncSessionRequestSchema = z.object({
  remotePort: z.number().int().min(1).max(65535).default(5900),
  credentialToken: SshCredentialTokenSchema.nullable(),
});

export type SshKeyAlgorithm = z.infer<typeof SshKeyAlgorithmSchema>;
export type CreateSshServerRequest = z.infer<typeof CreateSshServerRequestSchema>;
export type UpdateSshServerRequest = z.infer<typeof UpdateSshServerRequestSchema>;
export type SshServerEncryptedCredential = z.infer<typeof SshServerEncryptedCredentialSchema>;
export type SshCredentialExchangeRequest = z.infer<typeof SshCredentialExchangeRequestSchema>;
export type SshCredentialToken = z.infer<typeof SshCredentialTokenSchema>;
export type CreateSshServerSessionRequest = z.infer<typeof CreateSshServerSessionRequestSchema>;
export type DeleteSshServerSessionRequest = z.infer<typeof DeleteSshServerSessionRequestSchema>;
export type CheckSshServerPrerequisitesRequest = z.infer<typeof CheckSshServerPrerequisitesRequestSchema>;
export type GetDevboxTemplatesRequest = z.infer<typeof GetDevboxTemplatesRequestSchema>;
export type CreateVncSessionRequest = z.infer<typeof CreateVncSessionRequestSchema>;
