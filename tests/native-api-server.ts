import { matchRoute, type RouteContext } from "@pablozaiden/webapp/server";
import type { Server } from "bun";
import { apiRoutes } from "../src/api";
import { testOwnerUser } from "./setup";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

export interface NativeApiServerOptions {
  /** Bun.serve's idleTimeout value, expressed in seconds. */
  idleTimeout?: number;
  /** User identity used by the native route harness. */
  user?: CurrentUser;
}

export function serveNativeApiRoutes(options: NativeApiServerOptions = {}): Server<unknown> {
  return Bun.serve({
    port: 0,
    ...(options.idleTimeout === undefined ? {} : { idleTimeout: options.idleTimeout }),
    fetch: async (req, server) => {
      const matched = matchRoute(apiRoutes, new URL(req.url).pathname);
      if (!matched) {
        return new Response("Not found", { status: 404 });
      }

      const handler = matched.route[req.method as keyof typeof matched.route]
        ?? (req.method === "HEAD" ? matched.route.GET : undefined);
      if (typeof handler !== "function") {
        return new Response("Method not allowed", { status: 405 });
      }

      const context: Partial<RouteContext> = {
        params: matched.params,
        server,
        requireUser: () => options.user ?? testOwnerUser,
      };
      return await handler(req, context as RouteContext) ?? new Response(null, { status: 204 });
    },
  });
}
