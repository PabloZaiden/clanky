import { z } from "zod";
import type { WebAppClientCredentials } from "./client-credentials";

const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().positive().finite(),
  interval: z.number().positive().finite(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().positive().finite(),
});

export class ClientAuthorizationError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "ClientAuthorizationError";
  }
}

export function clientApiUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl}/`).toString();
}

async function authRequest(baseUrl: string, path: string, body: object, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetch(clientApiUrl(baseUrl, path), {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({
      error: z.string(),
      error_description: z.string().optional(),
      message: z.string().optional(),
    }).safeParse(value);
    throw new ClientAuthorizationError(
      parsed.success ? parsed.data.error_description ?? parsed.data.message ?? parsed.data.error : `Authorization failed (${response.status}).`,
      parsed.success ? parsed.data.error : "authorization_failed",
      response.status,
    );
  }
  return value;
}

function tokenCredentials(baseUrl: string, clientId: string, value: unknown): WebAppClientCredentials {
  const tokens = tokenSchema.parse(value);
  return {
    baseUrl, clientId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1_000,
  };
}

function waitForAuthorization(interval: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, interval);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function authorizeClient(input: {
  baseUrl: string;
  signal: AbortSignal;
  onVerification(info: { url: string; code: string }): void;
}): Promise<WebAppClientCredentials> {
  const clientId = `webapp-client-${crypto.randomUUID()}`;
  const device = deviceSchema.parse(await authRequest(input.baseUrl, "/api/auth/device", { clientId }, input.signal));
  const verification = new URL(device.verification_uri_complete);
  if (verification.origin !== new URL(input.baseUrl).origin) {
    throw new Error("The authorization page belongs to a different server.");
  }
  input.onVerification({ url: verification.toString(), code: device.user_code });
  const deadline = AbortSignal.timeout(device.expires_in * 1_000);
  const signal = AbortSignal.any([input.signal, deadline]);
  let interval = device.interval * 1_000;
  while (true) {
    await waitForAuthorization(interval, signal);
    try {
      return tokenCredentials(input.baseUrl, clientId, await authRequest(input.baseUrl, "/api/auth/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: clientId,
      }, signal));
    } catch (error) {
      if (!(error instanceof ClientAuthorizationError)) throw error;
      if (error.code === "slow_down") interval += 5_000;
      else if (error.code !== "authorization_pending") throw error;
    }
  }
}

export async function refreshClientCredentials(credentials: WebAppClientCredentials): Promise<WebAppClientCredentials> {
  return tokenCredentials(credentials.baseUrl, credentials.clientId, await authRequest(credentials.baseUrl, "/api/auth/token", {
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
    client_id: credentials.clientId,
  }));
}

export async function revokeClientCredentials(credentials: WebAppClientCredentials): Promise<void> {
  await authRequest(credentials.baseUrl, "/api/auth/revoke", { refreshToken: credentials.refreshToken });
}
