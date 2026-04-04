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
