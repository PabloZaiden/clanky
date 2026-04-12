/**
 * Helpers for deriving the browser-visible request origin behind reverse proxies.
 */

function getFirstHeaderValue(headers: Headers, name: string): string | undefined {
  const value = headers.get(name)?.split(",")[0]?.trim();
  return value || undefined;
}

function parseAbsoluteUrl(rawValue?: string): URL | undefined {
  if (!rawValue || rawValue === "null") {
    return undefined;
  }

  try {
    return new URL(rawValue);
  } catch {
    return undefined;
  }
}

export interface RequestOriginInfo {
  origin: string;
  hostname: string;
  secure: boolean;
}

export type SameOriginHeaderSource = "origin" | "referer";

export interface SameOriginCheckResult {
  allowed: boolean;
  expectedOrigin: string;
  actualOrigin?: string;
  source?: SameOriginHeaderSource;
  reason?: "missing" | "invalid" | "mismatch";
}

export function getEffectiveRequestOriginInfo(req: Request): RequestOriginInfo {
  const requestUrl = new URL(req.url);
  const forwardedHost = getFirstHeaderValue(req.headers, "x-forwarded-host");
  const forwardedProto = getFirstHeaderValue(req.headers, "x-forwarded-proto")?.toLowerCase();
  const host = forwardedHost || req.headers.get("host") || requestUrl.host;
  const protocol = forwardedProto || requestUrl.protocol.replace(":", "").toLowerCase();
  const fallbackUrl = new URL(`${protocol}://${host}`);

  return {
    origin: fallbackUrl.origin,
    hostname: fallbackUrl.hostname,
    secure: fallbackUrl.protocol === "https:",
  };
}

export function getRequestOriginInfo(req: Request): RequestOriginInfo {
  const originUrl =
    parseAbsoluteUrl(getFirstHeaderValue(req.headers, "origin")) ||
    parseAbsoluteUrl(getFirstHeaderValue(req.headers, "referer"));

  if (originUrl) {
    return {
      origin: originUrl.origin,
      hostname: originUrl.hostname,
      secure: originUrl.protocol === "https:",
    };
  }

  return getEffectiveRequestOriginInfo(req);
}

function checkCandidateOrigin(
  candidateUrl: URL | undefined,
  expectedOrigin: string,
  source: SameOriginHeaderSource,
): SameOriginCheckResult {
  if (!candidateUrl) {
    return {
      allowed: false,
      expectedOrigin,
      source,
      reason: "invalid",
    };
  }

  if (candidateUrl.origin !== expectedOrigin) {
    return {
      allowed: false,
      expectedOrigin,
      actualOrigin: candidateUrl.origin,
      source,
      reason: "mismatch",
    };
  }

  return {
    allowed: true,
    expectedOrigin,
    actualOrigin: candidateUrl.origin,
    source,
  };
}

export function checkRequestSameOrigin(req: Request): SameOriginCheckResult {
  const expectedOrigin = getEffectiveRequestOriginInfo(req).origin;
  const originHeader = getFirstHeaderValue(req.headers, "origin");

  if (originHeader !== undefined) {
    return checkCandidateOrigin(parseAbsoluteUrl(originHeader), expectedOrigin, "origin");
  }

  const refererHeader = getFirstHeaderValue(req.headers, "referer");
  if (refererHeader !== undefined) {
    return checkCandidateOrigin(parseAbsoluteUrl(refererHeader), expectedOrigin, "referer");
  }

  return {
    allowed: false,
    expectedOrigin,
    reason: "missing",
  };
}
