/**
 * Bearer token and device authorization API routes.
 */

import { z } from "zod";
import { createLogger } from "../core/logger";
import {
  approveDeviceAuthorizationRequest,
  AuthError,
  createDeviceAuthorizationRequest,
  denyDeviceAuthorizationRequest,
  exchangeDeviceCode,
  exchangeRefreshToken,
  getDeviceVerificationDetails,
  getDiscoveryDocument,
  getPublicJwks,
  getTokenIssuerSettings,
  listAuthSessions,
  revokeAuthSession,
  updateTokenIssuerSettings,
} from "../core/token-auth";
import { authorizeApplicationRequest } from "./application-auth";
import { isPasskeyAuthRequired, isPasskeySessionAuthenticated } from "../core/passkey-auth";
import { errorResponse, successResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const log = createLogger("api:auth");

const DeviceStartRequestSchema = z.object({
  clientId: z.string().trim().min(1).max(200).optional(),
  scope: z.string().trim().max(500).optional(),
});

const DeviceVerificationActionSchema = z.object({
  userCode: z.string().trim().min(1).max(32),
});

const RefreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().trim().min(1),
  client_id: z.string().trim().min(1).max(200).optional(),
});
const RefreshEndpointRequestSchema = RefreshGrantSchema.omit({
  grant_type: true,
});

const DeviceGrantSchema = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string().trim().min(1),
  client_id: z.string().trim().min(1).max(200).optional(),
});

const TokenRequestSchema = z.union([RefreshGrantSchema, DeviceGrantSchema]);

const RevokeRequestSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  refreshToken: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.sessionId || value.refreshToken), {
  message: "sessionId or refreshToken is required",
});

const IssuerSettingsSchema = z.object({
  canonicalIssuer: z.string().trim().min(1).nullable(),
});

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return errorResponse(error.code, error.message, error.status);
  }
  log.error("Unexpected auth route failure", { error: String(error) });
  return errorResponse("auth_failed", "An unexpected authentication error occurred", 500);
}

function tokenErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return Response.json(
      {
        error: error.code,
        error_description: error.message,
      },
      { status: error.status },
    );
  }
  log.error("Unexpected token endpoint failure", { error: String(error) });
  return Response.json(
    {
      error: "server_error",
      error_description: "An unexpected authentication error occurred",
    },
    { status: 500 },
  );
}

function tokenSuccessResponse(tokenSet: {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
}): Response {
  return Response.json({
    access_token: tokenSet.accessToken,
    refresh_token: tokenSet.refreshToken,
    token_type: tokenSet.tokenType,
    expires_in: tokenSet.expiresIn,
    scope: tokenSet.scope,
  });
}

async function requirePasskeyApprovalAccess(req: Request): Promise<void> {
  if (await isPasskeyAuthRequired() && !await isPasskeySessionAuthenticated(req)) {
    throw new AuthError("authentication_required", "Passkey authentication is required", 401);
  }
}

async function handleTokenExchange(req: Request): Promise<Response> {
  const validation = await parseAndValidate(TokenRequestSchema, req);
  if (!validation.success) {
    return validation.response;
  }

  try {
    if (validation.data.grant_type === "refresh_token") {
      const tokenSet = await exchangeRefreshToken({
        clientId: validation.data.client_id,
        refreshToken: validation.data.refresh_token,
      });
      return tokenSuccessResponse(tokenSet);
    }

    const tokenSet = await exchangeDeviceCode({
      clientId: validation.data.client_id,
      deviceCode: validation.data.device_code,
    });
    return tokenSuccessResponse(tokenSet);
  } catch (error) {
    return tokenErrorResponse(error);
  }
}

export const authRoutes = {
  "/api/auth/device": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(DeviceStartRequestSchema, req, {
        allowEmptyBody: true,
      });
      if (!validation.success) {
        return validation.response;
      }

      try {
        const authorization = await createDeviceAuthorizationRequest(req, validation.data);
        return Response.json({
          device_code: authorization.deviceCode,
          user_code: authorization.userCode,
          verification_uri: authorization.verificationUri,
          verification_uri_complete: authorization.verificationUriComplete,
          expires_in: authorization.expiresIn,
          interval: authorization.interval,
        });
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/device/verification": {
    async GET(req: Request): Promise<Response> {
      const userCode = new URL(req.url).searchParams.get("user_code")?.trim();
      if (!userCode) {
        return errorResponse("invalid_user_code", "user_code query parameter is required", 400);
      }

      try {
        await requirePasskeyApprovalAccess(req);
        const details = await getDeviceVerificationDetails(userCode);
        return Response.json(details);
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/device/approve": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(DeviceVerificationActionSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const details = await approveDeviceAuthorizationRequest(req, validation.data.userCode);
        return Response.json(details);
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/device/deny": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(DeviceVerificationActionSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const details = await denyDeviceAuthorizationRequest(req, validation.data.userCode);
        return Response.json(details);
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/token": {
    async POST(req: Request): Promise<Response> {
      return await handleTokenExchange(req);
    },
  },

  "/api/auth/refresh": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(RefreshEndpointRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const tokenSet = await exchangeRefreshToken({
          clientId: validation.data.client_id,
          refreshToken: validation.data.refresh_token,
        });
        return tokenSuccessResponse(tokenSet);
      } catch (error) {
        return tokenErrorResponse(error);
      }
    },
  },

  "/api/auth/revoke": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(RevokeRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        await revokeAuthSession(validation.data);
        return successResponse();
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/sessions": {
    async GET(): Promise<Response> {
      try {
        return Response.json(await listAuthSessions());
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/sessions/:id": {
    async DELETE(req: Request & { params: { id: string } }): Promise<Response> {
      try {
        await revokeAuthSession({ sessionId: req.params.id });
        return successResponse();
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/api/auth/status": {
    async GET(req: Request): Promise<Response> {
      const { state, response } = await authorizeApplicationRequest(req);
      if (response || !state) {
        return response ?? errorResponse("authentication_required", "Authentication is required", 401);
      }

      return Response.json({
        authenticated: true,
        authKind: state.kind,
        subject: state.claims?.sub ?? null,
        clientId: state.claims?.clientId ?? null,
        scope: state.claims?.scope ?? null,
      });
    },
  },

  "/api/auth/issuer": {
    async GET(): Promise<Response> {
      try {
        return Response.json(await getTokenIssuerSettings());
      } catch (error) {
        return authErrorResponse(error);
      }
    },

    async PUT(req: Request): Promise<Response> {
      const validation = await parseAndValidate(IssuerSettingsSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        return Response.json(await updateTokenIssuerSettings(validation.data.canonicalIssuer));
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/.well-known/jwks.json": {
    async GET(): Promise<Response> {
      try {
        return Response.json(await getPublicJwks());
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },

  "/.well-known/openid-configuration": {
    async GET(req: Request): Promise<Response> {
      try {
        return Response.json(await getDiscoveryDocument(req));
      } catch (error) {
        return authErrorResponse(error);
      }
    },
  },
};
