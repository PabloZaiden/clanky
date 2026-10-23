/**
 * Collaboration boundary responses with intentional outcome-based logging.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { domainErrorResponse } from "./helpers";
import type { DomainErrorPolicyName } from "./domain-error-policy";

const log = createLogger("api:collaboration");

export function workspaceClientErrorResponse(error: unknown, policy: DomainErrorPolicyName = "authenticated"): Response {
  const response = domainErrorResponse(error, {
    policy,
    fallback: { error: "collaboration_failed", message: "Workspace collaboration failed.", status: 500 },
  });
  log[response.status >= 500 ? "error" : "warn"]("Workspace collaboration request failed", {
    status: response.status, error: String(error),
  });
  return response;
}
