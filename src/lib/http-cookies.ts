export interface HttpCookie {
  name: string;
  value: string;
}

export function parseCookieHeader(rawCookieHeader?: string | null): HttpCookie[] {
  if (!rawCookieHeader) {
    return [];
  }

  const cookies: HttpCookie[] = [];
  for (const pair of rawCookieHeader.split(";")) {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    cookies.push({ name, value });
  }

  return cookies;
}

export function formatCookieHeader(cookies: ReadonlyArray<HttpCookie>): string | undefined {
  if (cookies.length === 0) {
    return undefined;
  }

  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
