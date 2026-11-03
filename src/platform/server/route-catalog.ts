import { createRouteCatalog as createCoreCatalog, findRouteCatalogEntry as findCoreCatalogEntry } from "@pablozaiden/webapp/server";
import { compileRouteTable, resolveRouteOperationMetadata, type HttpMethod, type RouteAuth, type RouteAutomationMetadata, type RouteOperationMetadata, type RouteTable, type SameOriginMode } from "./routes";

export interface RouteCatalogEntry extends RouteOperationMetadata {
  path: string;
  cliPath: string;
  methods: HttpMethod[];
  auth: RouteAuth;
  sameOrigin: SameOriginMode;
  scopes: string[];
  tags: string[];
  operations?: Partial<Record<HttpMethod, RouteOperationMetadata>>;
}

export interface ResolvedRouteOperation extends RouteOperationMetadata {
  method: HttpMethod;
  automation: RouteAutomationMetadata;
}

export function resolveRouteOperation(entry: RouteCatalogEntry, method: HttpMethod): ResolvedRouteOperation {
  if (!entry.methods.includes(method)) {
    throw new Error(`Method ${method} is not available for ${entry.path}`);
  }
  const metadata = resolveRouteOperationMetadata(entry, method);
  return {
    ...metadata,
    method,
    automation: metadata.automation ?? { policy: "excluded" },
  };
}

export interface RouteCatalogMatch {
  entry: RouteCatalogEntry;
  path: string;
  params: Record<string, string>;
}

export function createRouteCatalog<TEvent = unknown>(routes: RouteTable<TEvent>): RouteCatalogEntry[] {
  compileRouteTable(routes);
  return (createCoreCatalog(routes as never) as unknown as RouteCatalogEntry[]).map(entry => ({
    ...entry,
    auth: entry.auth ?? "required",
    sameOrigin: entry.sameOrigin ?? "mutations",
    scopes: entry.scopes ?? [],
    tags: entry.tags ?? [],
  }));
}

export function findRouteCatalogEntry(catalog: readonly RouteCatalogEntry[], input: string): RouteCatalogMatch | undefined {
  return findCoreCatalogEntry(catalog as never, input) as RouteCatalogMatch | undefined;
}
