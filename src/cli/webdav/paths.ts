/**
 * DAV URLs expose host-absolute paths; the workspace is only the initial URL.
 */

import type { FileSystemInfo } from "../../contracts/schemas/file-system";
import { DavError } from "./protocol";

export function davHref(path: string, kind: "file" | "directory", style: FileSystemInfo["pathStyle"]): string {
  const normalized = style === "windows" ? path.replaceAll("\\", "/") : path;
  const absolute = style === "windows" && normalized.startsWith("//")
    ? `/UNC/${normalized.slice(2)}` : normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = absolute.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return kind === "directory" && !encoded.endsWith("/") ? `${encoded}/` : encoded;
}

export function davHostPath(pathname: string, info: FileSystemInfo): string {
  let decoded: string;
  try {
    decoded = pathname.split("/").map((segment) => {
      const value = decodeURIComponent(segment);
      if (value.includes("/") || (info.pathStyle === "windows" && value.includes("\\")) || value.includes("\0")) {
        throw new DavError(400, "Ambiguous DAV path encoding.");
      }
      return value;
    }).join("/");
  } catch (error) {
    if (error instanceof DavError) throw error;
    throw new DavError(400, "Invalid DAV path encoding.");
  }
  if (info.pathStyle === "posix") return decoded || "/";
  if (decoded.startsWith("/UNC/")) return `\\\\${decoded.slice(5).replaceAll("/", "\\")}`;
  const windows = decoded.replace(/^\/(?=[A-Za-z]:\/)/, "").replaceAll("/", "\\");
  if (/^[A-Za-z]:\\/.test(windows) || windows.startsWith("\\\\")) return windows;
  if (decoded === "/") {
    const drive = /^[A-Za-z]:/.exec(info.directory)?.[0];
    if (drive) return `${drive}\\`;
  }
  throw new DavError(400, "Windows DAV paths must include an absolute drive or UNC share.");
}

export function davDestination(value: string, request: URL, info: FileSystemInfo): string {
  let destination: URL;
  try { destination = new URL(value, request); }
  catch { throw new DavError(400, "Invalid DAV destination."); }
  if (destination.origin !== request.origin || destination.username || destination.password || destination.search || destination.hash) {
    throw new DavError(502, "DAV destinations must use this local endpoint.");
  }
  return davHostPath(destination.pathname, info);
}
