import { z } from "zod";

export const DeviceStartRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(200).optional(),
  scope: z.string().trim().max(500).optional(),
});

export const DeviceVerificationActionSchema = z.object({
  userCode: z.string().trim().min(1).max(32),
});

export const RefreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().trim().min(1),
  client_id: z.string().trim().min(1).max(200).optional(),
});

export const RefreshEndpointRequestSchema = RefreshGrantSchema.omit({
  grant_type: true,
});

export const DeviceGrantSchema = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string().trim().min(1),
  client_id: z.string().trim().min(1).max(200).optional(),
});

export const TokenRequestSchema = z.union([RefreshGrantSchema, DeviceGrantSchema]);

export const PublicRevokeRequestSchema = z.object({
  refreshToken: z.string().trim().min(1),
}).strict();

export const IssuerSettingsSchema = z.object({
  canonicalIssuer: z.string().trim().min(1).nullable(),
});
