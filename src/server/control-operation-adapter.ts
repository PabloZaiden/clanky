import { createLogger, type RouteCatalogEntry, type WebAppServer } from "@pablozaiden/webapp/server";
import type { ClankyRealtimeEvent } from "@/shared/realtime";
import { ControlOperationAuthority } from "../core/control-authority";
import type { ControlAccess } from "../core/control-session-service";
import { runWithCurrentUser } from "../context/user-context";
import { DomainError, isDomainError } from "../domain/domain-error";
import { readOperationResponse } from "./operation-response";

const log = createLogger("server:control-operations");

export function createControlOperationAuthority(
  app: WebAppServer<ClankyRealtimeEvent>, catalog: readonly RouteCatalogEntry[], access: ControlAccess,
): ControlOperationAuthority {
  return new ControlOperationAuthority({
    grant: access.grant, catalog, revalidate: access.revalidate,
    dispatch: async (input, authorized) => {
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(), 30_000);
      let abortListener: (() => void) | undefined;
      try {
        const dispatch = async () => {
          const headers = new Headers({ "content-type": "application/json" });
          for (const [name, value] of Object.entries(input.headers ?? {})) headers.set(name, value);
          const request = new Request(new URL(input.path, "http://clanky.invalid"), {
            method: input.method, headers, signal,
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
          });
          const response = await app.dispatchAuthenticated(request, {
            userId: access.grant.user.id,
            allowPublic: true,
            authorize: (operation) => operation.path === authorized.entry.path
              && operation.method === authorized.method
              && JSON.stringify(operation.params) === JSON.stringify(authorized.params) ? authorized : false,
            run: async ({ actor }, invoke) => await runWithCurrentUser(actor, invoke),
          });
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
        clearTimeout(timer);
        if (abortListener) signal.removeEventListener("abort", abortListener);
      }
    },
  });
}
