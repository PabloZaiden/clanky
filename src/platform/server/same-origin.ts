import { checkSameOrigin as checkOrigin } from "@pablozaiden/webapp/server";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RuntimeConfig } from "./runtime-config";
import type { SameOriginMode } from "./routes";

export function checkSameOrigin(
  request: Request,
  config: RuntimeConfig,
  auth: AuthenticatedRequestState,
  mode: SameOriginMode = "mutations",
): Response | undefined {
  return checkOrigin(request, config, {
    credential: auth.kind === "api-key" || auth.kind === "bearer" ? "explicit" : "ambient",
  }, mode);
}
