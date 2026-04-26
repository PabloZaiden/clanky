/**
 * Shared HTTP helpers for passkey-authenticated browser flows.
 */

export const PASSKEY_AUTH_REQUIRED_HEADER = "X-Ralpher-Passkey-Auth-Required";

export function isPasskeyAuthRequiredResponse(response: Response): boolean {
  return response.headers.get(PASSKEY_AUTH_REQUIRED_HEADER) === "true";
}
