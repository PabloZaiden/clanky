/**
 * Browser helpers for building app-local URLs when Clanky is mounted
 * behind a reverse proxy subpath.
 */

import {
  applyPublicBasePath,
  getPublicBasePathFromPathname,
  normalizePublicBasePath,
} from "@/shared";

let configuredPublicBasePath: string | undefined;
let configuredApiBaseUrl: string | undefined;
let configuredWebSocketBaseUrl: string | undefined;
const DIRECT_APP_ROUTES = ["/device"];

function normalizeOptionalBaseUrl(rawValue?: string | null): string | undefined {
  const trimmedValue = rawValue?.trim();
  if (!trimmedValue) {
    return undefined;
  }

  return trimmedValue.replace(/\/+$/, "");
}

function buildAbsoluteUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

export function configureClientRuntime(options: {
  publicBasePath?: string | null;
  apiBaseUrl?: string | null;
  wsBaseUrl?: string | null;
} = {}): void {
  setConfiguredPublicBasePath(options.publicBasePath);
  configuredApiBaseUrl = normalizeOptionalBaseUrl(options.apiBaseUrl);
  configuredWebSocketBaseUrl = normalizeOptionalBaseUrl(options.wsBaseUrl);
}

function getPublicBasePathFromWindowLocation(): string {
  const pathname = window.location.pathname;
  for (const route of DIRECT_APP_ROUTES) {
    if (pathname.endsWith(route)) {
      return normalizePublicBasePath(pathname.slice(0, -route.length));
    }
  }
  return getPublicBasePathFromPathname(pathname);
}

export function setConfiguredPublicBasePath(basePath?: string | null): void {
  if (basePath == null) {
    configuredPublicBasePath = undefined;
    return;
  }

  const normalizedBasePath = normalizePublicBasePath(basePath);
  configuredPublicBasePath = normalizedBasePath || undefined;
}

export function getConfiguredPublicBasePath(): string {
  if (configuredPublicBasePath !== undefined) {
    return configuredPublicBasePath;
  }

  if (typeof window === "undefined") {
    return "";
  }

  return getPublicBasePathFromWindowLocation();
}

export function appPath(path: string): string {
  if (configuredApiBaseUrl) {
    return buildAbsoluteUrl(configuredApiBaseUrl, path);
  }
  return applyPublicBasePath(getConfiguredPublicBasePath(), path);
}

export function appAbsoluteUrl(path: string): string {
  if (configuredApiBaseUrl) {
    return buildAbsoluteUrl(configuredApiBaseUrl, path);
  }

  if (typeof window === "undefined") {
    return appPath(path);
  }

  return new URL(appPath(path), window.location.origin).toString();
}

export function appWebSocketUrl(path: string): string {
  const configuredWsBaseUrl = configuredWebSocketBaseUrl ?? configuredApiBaseUrl;
  if (configuredWsBaseUrl) {
    const url = new URL(buildAbsoluteUrl(configuredWsBaseUrl, path));
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    }
    return url.toString();
  }

  if (typeof window === "undefined") {
    return appPath(path);
  }

  const url = new URL(appPath(path), window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return await fetch(appPath(path), init);
}
