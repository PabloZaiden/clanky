/**
 * Browser-facing proxy routes for forwarded ports.
 */

import type { Server } from "bun";
import { portForwardManager } from "../core/port-forward-manager";
import { errorResponse } from "./helpers";
import type { WebSocketData } from "./websocket";
import { requireCurrentUser } from "../core/user-context";

function getBasePath(taskId: string, forwardId: string): string {
  return `/task/${taskId}/port/${forwardId}`;
}

function normalizeProxyPath(rawPath?: string): string {
  if (!rawPath) {
    return "/";
  }
  return rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
}

function appendTrailingSlash(urlString: string): string {
  const url = new URL(urlString);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url.toString();
}

function extractWildcardPath(
  req: Request,
  taskId: string,
  forwardId: string,
): string {
  const pathname = new URL(req.url).pathname;
  const basePath = `${getBasePath(taskId, forwardId)}/`;
  if (!pathname.startsWith(basePath)) {
    return "/";
  }
  const remainder = pathname.slice(basePath.length);
  return normalizeProxyPath(remainder);
}

function rewriteLocationHeader(location: string, localPort: number, basePath: string): string {
  if (location.startsWith("/")) {
    return `${basePath}${location}`;
  }

  try {
    const parsed = new URL(location);
    const localHosts = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::1"]);
    if (parsed.port === String(localPort) && localHosts.has(parsed.hostname)) {
      return `${basePath}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    return location;
  }

  return location;
}

function rewriteHtmlResponse(html: string, basePath: string): string {
  const basePathWithSlash = `${basePath}/`;
  const replacements: Array<[RegExp, string]> = [
    [/href="\//g, `href="${basePathWithSlash}`],
    [/href='\//g, `href='${basePathWithSlash}`],
    [/src="\//g, `src="${basePathWithSlash}`],
    [/src='\//g, `src='${basePathWithSlash}`],
    [/action="\//g, `action="${basePathWithSlash}`],
    [/action='\//g, `action='${basePathWithSlash}`],
    [/content="\//g, `content="${basePathWithSlash}`],
    [/content='\//g, `content='${basePathWithSlash}`],
    [/url\(\//g, `url(${basePathWithSlash}`],
    [/fetch\("\//g, `fetch("${basePathWithSlash}`],
    [/fetch\('\//g, `fetch('${basePathWithSlash}`],
    [/new WebSocket\("\//g, `new WebSocket("${basePathWithSlash}`],
    [/new WebSocket\('\//g, `new WebSocket('${basePathWithSlash}`],
  ];

  let rewritten = html;
  for (const [pattern, replacement] of replacements) {
    rewritten = rewritten.replace(pattern, replacement);
  }

  if (/<head[^>]*>/i.test(rewritten)) {
    return rewritten.replace(/<head([^>]*)>/i, `<head$1><base href="${basePathWithSlash}">`);
  }

  return `<base href="${basePathWithSlash}">${rewritten}`;
}

async function requireActiveForward(taskId: string, forwardId: string) {
  const forward = await portForwardManager.getPortForward(forwardId);
  if (!forward || forward.config.taskId !== taskId) {
    return errorResponse("not_found", "Port forward not found", 404);
  }
  if (forward.state.status !== "active") {
    return errorResponse("port_forward_inactive", "Port forward is not active", 409);
  }
  return forward;
}

async function proxyHttpRequest(
  req: Request,
  taskId: string,
  forwardId: string,
  rawPath?: string,
): Promise<Response> {
  const forwardOrResponse = await requireActiveForward(taskId, forwardId);
  if (forwardOrResponse instanceof Response) {
    return forwardOrResponse;
  }

  const forward = forwardOrResponse;
  const basePath = getBasePath(taskId, forwardId);
  const upstreamPath = normalizeProxyPath(rawPath);
  const url = new URL(req.url);
  const targetUrl = new URL(`http://${"127.0.0.1"}:${String(forward.config.localPort)}${upstreamPath}${url.search}`);
  const headers = new Headers(req.headers);
  headers.set("host", `127.0.0.1:${String(forward.config.localPort)}`);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
  headers.set("x-forwarded-prefix", `${basePath}/`);

  const upstreamResponse = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(upstreamResponse.headers);
  const location = responseHeaders.get("location");
  if (location) {
    responseHeaders.set("location", rewriteLocationHeader(location, forward.config.localPort, basePath));
  }

  const contentType = responseHeaders.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    const html = await upstreamResponse.text();
    return new Response(rewriteHtmlResponse(html, basePath), {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

async function upgradeProxyWebSocket(
  req: Request,
  server: Server<WebSocketData>,
  taskId: string,
  forwardId: string,
  rawPath?: string,
): Promise<Response | undefined> {
  const forwardOrResponse = await requireActiveForward(taskId, forwardId);
  if (forwardOrResponse instanceof Response) {
    return forwardOrResponse;
  }

  const forward = forwardOrResponse;
  const user = requireCurrentUser();
  const url = new URL(req.url);
  const targetUrl = `ws://127.0.0.1:${String(forward.config.localPort)}${normalizeProxyPath(rawPath)}${url.search}`;
  const upgraded = server.upgrade(req, {
    data: {
      taskId,
      portForwardId: forwardId,
      portForwardMode: true,
      proxyTargetUrl: targetUrl,
      user,
    } as WebSocketData,
  });

  if (upgraded) {
    return undefined;
  }

  return new Response("WebSocket upgrade failed", { status: 400 });
}

export const portForwardProxyRoutes = {
  "/task/:taskId/port/:forwardId": async (
    req: Request & { params: { taskId: string; forwardId: string } },
    server: Server<WebSocketData>,
  ): Promise<Response | undefined> => {
    if (req.method === "GET" && !req.url.endsWith("/")) {
      return Response.redirect(appendTrailingSlash(req.url), 307);
    }
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return await upgradeProxyWebSocket(req, server, req.params.taskId, req.params.forwardId);
    }
    return await proxyHttpRequest(req, req.params.taskId, req.params.forwardId);
  },

  "/task/:taskId/port/:forwardId/*": async (
    req: Request & { params: { taskId: string; forwardId: string } },
    server: Server<WebSocketData>,
  ): Promise<Response | undefined> => {
    const wildcardPath = extractWildcardPath(req, req.params.taskId, req.params.forwardId);
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return await upgradeProxyWebSocket(
        req,
        server,
        req.params.taskId,
        req.params.forwardId,
        wildcardPath,
      );
    }
    return await proxyHttpRequest(
      req,
      req.params.taskId,
      req.params.forwardId,
      wildcardPath,
    );
  },
};
