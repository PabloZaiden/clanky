import { z } from "zod";
import { VALID_LOG_LEVELS } from "../contracts";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@pablozaiden/webapp/auth";

const nonEmptyString = z.string().min(1);
const optionalClientId = z.string().max(200).optional();
export const clientTicketRequestSchema = z.object({
  url: z.string().min(1).max(16_384),
  kind: z.enum(["websocket", "resource"]),
}).strict();
const authenticatorTransport = z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"]);
const clientExtensionResults = z.object({
  appid: z.boolean().optional(),
  credProps: z.object({ rk: z.boolean().optional() }).optional(),
  hmacCreateSecret: z.boolean().optional(),
});

export const registrationResponseSchema: z.ZodType<RegistrationResponseJSON> = z.object({
  id: nonEmptyString,
  rawId: nonEmptyString,
  response: z.object({
    clientDataJSON: nonEmptyString,
    attestationObject: nonEmptyString,
    authenticatorData: nonEmptyString.optional(),
    transports: z.array(authenticatorTransport).optional(),
    publicKeyAlgorithm: z.number().optional(),
    publicKey: nonEmptyString.optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults,
  type: z.literal("public-key"),
});

export const authenticationResponseSchema: z.ZodType<AuthenticationResponseJSON> = z.object({
  id: nonEmptyString,
  rawId: nonEmptyString,
  response: z.object({
    clientDataJSON: nonEmptyString,
    authenticatorData: nonEmptyString,
    signature: nonEmptyString,
    userHandle: nonEmptyString.optional(),
  }),
  authenticatorAttachment: z.enum(["cross-platform", "platform"]).optional(),
  clientExtensionResults,
  type: z.literal("public-key"),
});

export const passkeyBootstrapOptionsSchema = z.object({
  username: z.string().max(32).optional(),
});

export const setupOptionsSchema = z.object({
  token: z.string().max(512).optional(),
});

export const setupVerificationSchema = z.object({
  token: nonEmptyString,
  response: registrationResponseSchema,
});

export const createApiKeyRequestSchema = z.object({
  name: z.string().max(200).optional(),
  scopes: z.array(nonEmptyString).optional(),
  prefix: z.string().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/).optional(),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "expiresAt must be a valid date").optional(),
});

export const apiKeyAuthenticationRequestSchema = z.object({
  apiKey: nonEmptyString.max(512),
});

export const deviceAuthorizationRequestSchema = z.object({
  client_id: optionalClientId,
  clientId: optionalClientId,
  scope: z.string().max(512).optional(),
}).superRefine((value, context) => {
  if (value.client_id !== undefined && value.clientId !== undefined && value.client_id !== value.clientId) {
    context.addIssue({ code: "custom", path: ["clientId"], message: "client_id and clientId must match when both are provided" });
  }
}).transform(({ client_id, clientId, scope }) => ({
  clientId: clientId ?? client_id,
  scope,
}));

const deviceCodeActionInput = z.object({
  userCode: nonEmptyString.optional(),
  user_code: nonEmptyString.optional(),
}).superRefine((value, context) => {
  if (value.userCode === undefined && value.user_code === undefined) {
    context.addIssue({ code: "custom", path: ["userCode"], message: "userCode is required" });
  } else if (value.userCode !== undefined && value.user_code !== undefined && value.userCode !== value.user_code) {
    context.addIssue({ code: "custom", path: ["userCode"], message: "user_code and userCode must match when both are provided" });
  }
});

export const deviceCodeActionRequestSchema = deviceCodeActionInput.transform(({ userCode, user_code }) => ({
  userCode: userCode ?? user_code!,
}));

const tokenRequestFields = {
  grant_type: z.enum(["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"]).optional(),
  device_code: nonEmptyString.optional(),
  refresh_token: nonEmptyString.optional(),
  client_id: optionalClientId,
};

export const tokenRequestSchema = z.object(tokenRequestFields).superRefine((value, context) => {
  if (value.grant_type === "urn:ietf:params:oauth:grant-type:device_code" && value.device_code === undefined) {
    context.addIssue({ code: "custom", path: ["device_code"], message: "device_code is required for device-code grants" });
  }
  if (value.grant_type === "refresh_token" && value.refresh_token === undefined) {
    context.addIssue({ code: "custom", path: ["refresh_token"], message: "refresh_token is required for refresh grants" });
  }
  if (value.grant_type === undefined && value.device_code === undefined && value.refresh_token === undefined) {
    context.addIssue({ code: "custom", path: ["grant_type"], message: "A device_code or refresh_token is required" });
  }
});

export const refreshTokenRequestSchema = z.object({
  grant_type: z.literal("refresh_token").optional(),
  refresh_token: nonEmptyString,
  client_id: optionalClientId,
});

export const revokeRefreshTokenRequestSchema = z.object({
  refreshToken: nonEmptyString.optional(),
  refresh_token: nonEmptyString.optional(),
}).superRefine((value, context) => {
  if (value.refreshToken === undefined && value.refresh_token === undefined) {
    context.addIssue({ code: "custom", path: ["refreshToken"], message: "refresh_token is required" });
  } else if (value.refreshToken !== undefined && value.refresh_token !== undefined && value.refreshToken !== value.refresh_token) {
    context.addIssue({ code: "custom", path: ["refreshToken"], message: "refresh_token and refreshToken must match when both are provided" });
  }
}).transform(({ refreshToken, refresh_token }) => ({
  refreshToken: refreshToken ?? refresh_token!,
}));

export const createUserRequestSchema = z.object({
  username: z.string().max(32).optional(),
  role: z.enum(["admin", "user"]).optional(),
});

export const userRoleRequestSchema = z.object({
  role: z.enum(["admin", "user"]),
});

export const themePreferenceRequestSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
});

export const logLevelPreferenceRequestSchema = z.object({
  level: z.enum(VALID_LOG_LEVELS),
});

export const serverLogSettingsRequestSchema = z.object({
  enabled: z.boolean(),
});
