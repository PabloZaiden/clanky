/**
 * Browser helpers for building app-local URLs when Ralpher is mounted
 * behind a reverse proxy subpath.
 */

import {
  applyPublicBasePath,
  getPublicBasePathFromPathname,
  normalizePublicBasePath,
} from "../utils/public-base-path";

let configuredPublicBasePath: string | undefined;
export const PASSKEY_AUTH_REQUIRED_EVENT = "ralpher:passkey-auth-required";

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

  return getPublicBasePathFromPathname(window.location.pathname);
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
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(PASSKEY_AUTH_REQUIRED_EVENT));
  }
  return response;
}
