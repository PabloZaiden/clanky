import { z } from "zod";
import {
  createRouteCatalog,
  findRouteCatalogEntry,
  type RouteCatalogEntry,
} from "@pablozaiden/webapp/server";
import { routes } from "../server";

export type ApiEndpointCatalogEntry = RouteCatalogEntry;

function normalizeEndpointPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("API endpoint is required");
  }

  if (trimmed.startsWith("/api/")) {
    return trimmed;
  }
  if (trimmed.startsWith("api/")) {
    return `/${trimmed}`;
  }
  if (trimmed.startsWith("/")) {
    return `/api${trimmed}`;
  }
  return `/api/${trimmed}`;
}

export function getCliRouteCatalog(): ApiEndpointCatalogEntry[] {
  return createRouteCatalog(routes).filter((entry) => entry.path.startsWith("/api/"));
}

export function listApiEndpoints(): ApiEndpointCatalogEntry[] {
  return getCliRouteCatalog();
}

export function findApiEndpoint(input: string): ApiEndpointCatalogEntry | null {
  return findRouteCatalogEntry(getCliRouteCatalog(), input)?.entry ?? null;
}

export function normalizeApiEndpointPath(input: string): string {
  return normalizeEndpointPath(input);
}

export function formatSchema(schema: z.ZodTypeAny): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2);
}
