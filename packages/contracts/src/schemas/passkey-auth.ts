import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { z } from "zod";

export const CompletePasskeyRegistrationRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  response: z.custom<RegistrationResponseJSON>(
    (value: unknown) => typeof value === "object" && value !== null,
    "response is required",
  ),
});

export const CompletePasskeyAuthenticationRequestSchema = z.object({
  response: z.custom<AuthenticationResponseJSON>(
    (value: unknown) => typeof value === "object" && value !== null,
    "response is required",
  ),
});
