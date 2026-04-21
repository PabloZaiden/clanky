/**
 * Browser helpers for building app-local URLs when Ralpher is mounted
 * behind a reverse proxy subpath.
 */

import {
  applyPublicBasePath,
  getPublicBasePathFromPathname,
  normalizePublicBasePath,
} from "../utils/public-base-path";
import { isPasskeyAuthRequiredResponse } from "./passkey-auth-http";

let configuredPublicBasePath: string | undefined;
export const PASSKEY_AUTH_REQUIRED_EVENT = "ralpher:passkey-auth-required";
const DIRECT_APP_ROUTES = ["/device"];

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
  return applyPublicBasePath(getConfiguredPublicBasePath(), path);
}

export function appAbsoluteUrl(path: string): string {
  if (typeof window === "undefined") {
    return appPath(path);
  }

  return new URL(appPath(path), window.location.origin).toString();
}

export function appWebSocketUrl(path: string): string {
  if (typeof window === "undefined") {
    return appPath(path);
  }

  const url = new URL(appPath(path), window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function appFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(appPath(path), init);
  if (
    response.status === 401 &&
    typeof window !== "undefined" &&
    isPasskeyAuthRequiredResponse(response)
  ) {
    window.dispatchEvent(new Event(PASSKEY_AUTH_REQUIRED_EVENT));
  }
  return response;
}
