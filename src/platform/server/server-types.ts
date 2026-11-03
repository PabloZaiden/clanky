import type {
  WebAppDocumentConfig as CoreDocumentConfig,
  WebAppServer as CoreServer,
  WebAppServerConfig as CoreServerConfig,
  WebAppWebSocketData,
} from "@pablozaiden/webapp/server";
import type { LogLevelName, WebAppConfigResponse } from "../contracts";
import type { AuthenticatedDispatchOptions } from "./authenticated-dispatch";
import type { ClankyAccountStore } from "./auth/store";
import type { OAuthConfig, OAuthService } from "./auth/oauth-types";
import type { DelegatedDispatchOptions } from "./delegation";
import type { RouteCatalogEntry } from "./route-catalog";
import type { RouteTable, WebAppRouteMiddleware } from "./routes";
import type { RuntimeConfig } from "./runtime-config";

export type { WebAppWebSocketData };

export interface WebAppServerConfig<TEvent = unknown> extends Omit<
  CoreServerConfig<TEvent>,
  "runtimeConfig" | "web" | "routes" | "routeMiddleware" | "configResponse"
> {
  runtimeConfig?: RuntimeConfig;
  web?: CoreDocumentConfig & { mode?: "app" | "auth" } | false;
  store: ClankyAccountStore;
  routes?: RouteTable<TEvent>;
  routeMiddleware?: WebAppRouteMiddleware<TEvent>;
  requestFilter?: (request: Request) => boolean | Promise<boolean>;
  auth?: {
    passkeys?: boolean;
    apiKeys?: boolean;
    deviceAuth?: boolean;
    oauth?: OAuthConfig;
  };
  logLevel?: { onChange?: (level: LogLevelName) => void };
  configResponse?: (req: Request, base: Readonly<WebAppConfigResponse>) => Record<string, unknown>;
}

export interface WebAppServer<TEvent = unknown> extends Omit<CoreServer<TEvent>, "config" | "routeCatalog"> {
  config: RuntimeConfig;
  store: ClankyAccountStore;
  oauth?: OAuthService;
  readonly routeCatalog: readonly RouteCatalogEntry[];
  dispatchDelegated<TAuthorization extends object>(
    req: Request,
    options: DelegatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined>;
  dispatchAuthenticated<TAuthorization extends object>(
    req: Request,
    options: AuthenticatedDispatchOptions<TAuthorization>,
  ): Promise<Response | undefined>;
}
