export interface HttpCookie {
  name: string;
  value: string;
}

export interface ParseCookieHeaderResult {
  cookies: HttpCookie[];
  valid: boolean;
}

export function parseCookieHeader(rawCookieHeader?: string | null): ParseCookieHeaderResult {
  if (!rawCookieHeader) {
    return {
      cookies: [],
      valid: true,
    };
  }

  const cookies: HttpCookie[] = [];
  let valid = true;
  for (const pair of rawCookieHeader.split(";")) {
    const trimmedPair = pair.trim();
    if (!trimmedPair) {
      continue;
    }

    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      valid = false;
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!name) {
      valid = false;
      continue;
    }

    cookies.push({ name, value });
  }

  return {
    cookies,
    valid,
  };
}

export function formatCookieHeader(cookies: ReadonlyArray<HttpCookie>): string | undefined {
  if (cookies.length === 0) {
    return undefined;
  }

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
