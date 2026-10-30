/**
 * DAV URLs expose host-absolute paths; the workspace is only the initial URL.
 */

import { DavError } from "./protocol";

export function davHref(path: string, kind: "file" | "directory"): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const encoded = absolute.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return kind === "directory" && !encoded.endsWith("/") ? `${encoded}/` : encoded;
}

export function davHostPath(pathname: string): string {
  let decoded: string;
  try {
    decoded = pathname.split("/").map((segment) => {
      const value = decodeURIComponent(segment);
      if (value.includes("/") || value.includes("\0")) {
        throw new DavError(400, "Ambiguous DAV path encoding.");
      }
      return value;
    }).join("/");
  } catch (error) {
    if (error instanceof DavError) throw error;
    throw new DavError(400, "Invalid DAV path encoding.");
  }
  return decoded || "/";
}

export function davDestination(value: string, request: URL): string {
  let destination: URL;
  try { destination = new URL(value, request); }
  catch { throw new DavError(400, "Invalid DAV destination."); }
  if (destination.origin !== request.origin || destination.username || destination.password || destination.search || destination.hash) {
    throw new DavError(502, "DAV destinations must use this local endpoint.");
  }
  return davHostPath(destination.pathname);
}
