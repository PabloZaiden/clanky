import { type RouteCatalogEntry } from "@/platform/server";
import { createLogger } from "@pablozaiden/webapp/server";
import type { WebAppServer } from "@/platform/server";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { ControlOperationAuthority } from "../core/control-authority";
import type { ControlAccess } from "../core/control-session-service";
import { runWithCurrentUser } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import { readOperationResponse } from "./operation-response";

const log = createLogger("server:control-operations");

export function createControlOperationAuthority(
  app: WebAppServer<ClankyRealtimeEvent>, catalog: readonly RouteCatalogEntry[], access: ControlAccess,
  getBaseUrl: () => string,
): ControlOperationAuthority {
  return new ControlOperationAuthority({
    grant: access.grant, catalog, revalidate: access.revalidate,
    dispatch: async (input, authorized) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), 30_000);
      let abortListener: (() => void) | undefined;
      let request: Request | undefined;
      try {
        const dispatch = async () => {
          const headers = new Headers({ "content-type": input.files?.raw ? input.files.contentType ?? "application/octet-stream" : "application/json" });
          for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
          for (const [name, value] of Object.entries(input.files?.headers ?? {})) headers.set(name, value);
          const body = input.files?.raw ? await input.files.requestBody(signal)
            : input.body === undefined ? undefined : JSON.stringify(input.body);
          request = new Request(new URL(input.path, getBaseUrl()), {
            method: input.method, headers, signal,
            ...(body === undefined ? {} : { body }),
          });
          const response = await app.dispatchAuthenticated(request, {
            userId: access.grant.user.id,
            allowPublic: true,
            authorize: (operation) => operation.path === authorized.entry.path
              && operation.method === authorized.method
              && JSON.stringify(operation.params) === JSON.stringify(authorized.params) ? authorized : false,
            run: async ({ actor }, invoke) => await runWithCurrentUser(actor, invoke),
          });
          if (input.files?.responseFile) {
            if (!response) throw new DomainError("control_operation_response", "The operation returned no response.");
            return await input.files.saveResponse(response.body, {
              ok: response.ok, status: response.status, contentType: response.headers.get("content-type"), signal,
            });
          }
          return await readOperationResponse(response, "control");
        };
        return await Promise.race([
          dispatch(),
          new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(new DomainError("control_operation_interrupted",
              "The operation was interrupted. Inspect its target before repeating a mutation."));
            signal.addEventListener("abort", abortListener, { once: true });
            if (signal.aborted) abortListener();
          }),
        ]);
      } catch (error) {
        log[isDomainError(error) ? "warn" : "error"]("Control API dispatch failed", {
          method: input.method, code: isDomainError(error) ? error.code : "unexpected_error",
        });
        return { ok: false, code: isDomainError(error) ? error.code : "control_operation_failed",
          message: "No authoritative result was received. Inspect the target before repeating a mutation." };
      } finally {
        if (request?.body && !request.body.locked) await request.body.cancel();
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener("abort", abortListener);
      }
    },
  });
}
