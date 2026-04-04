/**
 * Passkey authentication API routes.
 */

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";
import { createLogger } from "../core/logger";
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  completePasskeyAuthentication,
  completePasskeyRegistration,
  createPasskeyLogoutHeaders,
  getPasskeyAuthStatus,
  isPasskeyAuthRequired,
  isPasskeySessionAuthenticated,
  PasskeyAuthError,
  removeConfiguredPasskeys,
} from "../core/passkey-auth";
import type { PasskeyAuthStatusResponse } from "../types/api";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";

const log = createLogger("api:passkey-auth");

const CompletePasskeyRegistrationRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  response: z.custom<RegistrationResponseJSON>(
    (value: unknown) => typeof value === "object" && value !== null,
    "response is required",
  ),
});

const CompletePasskeyAuthenticationRequestSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value: unknown) => typeof value === "object" && value !== null,
    "response is required",
  ),
});

async function requirePasskeyManagementAccess(req: Request): Promise<void> {
  if (await isPasskeyAuthRequired() && !await isPasskeySessionAuthenticated(req)) {
    throw new PasskeyAuthError("authentication_required", "Passkey authentication is required", 401);
  }
}

function passkeyErrorResponse(error: unknown): Response {
  if (error instanceof PasskeyAuthError) {
    return errorResponse(error.code, error.message, error.status);
  }

  log.error("Unexpected passkey auth failure", { error: String(error) });
  return errorResponse("passkey_auth_failed", String(error), 500);
}

export const passkeyAuthRoutes = {
  "/api/passkey-auth/status": {
    async GET(req: Request): Promise<Response> {
      const status: PasskeyAuthStatusResponse = await getPasskeyAuthStatus(req);
      return Response.json(status);
    },
  },

  "/api/passkey-auth/registration/options": {
    async GET(req: Request): Promise<Response> {
      try {
        const result = await beginPasskeyRegistration(req);
        return Response.json(result.options, { headers: result.headers });
      } catch (error) {
        return passkeyErrorResponse(error);
      }
    },
  },

  "/api/passkey-auth/registration/verify": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(CompletePasskeyRegistrationRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const result = await completePasskeyRegistration(
          req,
          validation.data.response,
          validation.data.name,
        );
        return Response.json({
          success: true,
          passkey: {
            id: result.passkey.id,
            name: result.passkey.name,
            createdAt: result.passkey.createdAt,
            lastUsedAt: result.passkey.lastUsedAt,
          },
        }, {
          headers: result.headers,
        });
      } catch (error) {
        return passkeyErrorResponse(error);
      }
    },
  },

  "/api/passkey-auth/authentication/options": {
    async GET(req: Request): Promise<Response> {
      try {
        const result = await beginPasskeyAuthentication(req);
        return Response.json(result.options, { headers: result.headers });
      } catch (error) {
        return passkeyErrorResponse(error);
      }
    },
  },

  "/api/passkey-auth/authentication/verify": {
    async POST(req: Request): Promise<Response> {
      const validation = await parseAndValidate(CompletePasskeyAuthenticationRequestSchema, req);
      if (!validation.success) {
        return validation.response;
      }

      try {
        const result = await completePasskeyAuthentication(req, validation.data.response);
        return Response.json({
          success: true,
          passkey: {
            id: result.passkey.id,
            name: result.passkey.name,
            createdAt: result.passkey.createdAt,
            lastUsedAt: result.passkey.lastUsedAt,
          },
        }, {
          headers: result.headers,
        });
      } catch (error) {
        return passkeyErrorResponse(error);
      }
    },
  },

  "/api/passkey-auth/logout": {
    async POST(req: Request): Promise<Response> {
      return Response.json({ success: true }, { headers: createPasskeyLogoutHeaders(req) });
    },
  },

  "/api/passkey-auth/passkey": {
    async DELETE(req: Request): Promise<Response> {
      try {
        await requirePasskeyManagementAccess(req);
        const headers = await removeConfiguredPasskeys(req);
        return Response.json({ success: true }, { headers });
      } catch (error) {
        return passkeyErrorResponse(error);
      }
    },
  },
};
