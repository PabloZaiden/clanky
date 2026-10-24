import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { bootstrapOwner, CookieJar, requestWithCookies } from "./support/passkey";
import { operationSignal } from "./support/timeouts";

interface Tokens {
  access_token: string;
  refresh_token: string;
}

async function verifyStaticArtifacts(origin: string): Promise<void> {
  for (const mount of ["/", "/client/"]) {
    const page = await fetch(`${origin}${mount}`, { signal: operationSignal() });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
      .map(match => new URL(match[1]!, page.url))
      .filter(url => url.origin === origin && !url.hash);
    for (const asset of references) {
      const response = await fetch(asset, { signal: operationSignal() });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    }
  }
}

test("a statically hosted client authorizes, works with private files and retires its own session", async () => {
  const application = await E2EApplication.create();
  let staticHost: ReturnType<typeof Bun.serve> | undefined;
  try {
    const root = resolve(import.meta.dir, "../../dist/client");
    staticHost = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\/client\//, "/").replace(/\/$/, "/index.html");
        const file = Bun.file(join(root, path));
        return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
      },
    });
    const origin = `http://127.0.0.1:${staticHost.port}`;
    async function remote(path: string, options: RequestInit = {}, accessToken?: string): Promise<Response> {
      const headers = new Headers(options.headers);
      headers.set("origin", origin);
      if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
      return await application.request(path, { ...options, headers, includeOrigin: false });
    }
    async function remoteJson<T>(path: string, body: object, accessToken?: string): Promise<T> {
      const response = await remote(path, { method: "POST", body: JSON.stringify(body) }, accessToken);
      const text = await response.text();
      if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text}`);
      return JSON.parse(text) as T;
    }
    await verifyStaticArtifacts(origin);
    await application.start({
      disablePasskey: false,
      requestHostname: "localhost",
      env: { CLANKY_API_ONLY: "true" },
    });
    const cookies = new CookieJar();
    await bootstrapOwner(application, cookies);
    const clientId = `detached-${crypto.randomUUID()}`;
    const device = await remoteJson<{ device_code: string; user_code: string; verification_uri_complete: string }>(
      "/api/auth/device", { clientId },
    );
    expect(new URL(device.verification_uri_complete).origin).toBe(application.baseUrl);
    expect((await requestWithCookies(application, cookies, "/api/auth/device/approve", {
      method: "POST", body: JSON.stringify({ user_code: device.user_code }),
    })).status).toBe(200);
    const tokens = await remoteJson<Tokens>("/api/auth/token", {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code, client_id: clientId,
    });
    const config = await remote("/api/config", {}, tokens.access_token);
    expect(config.headers.get("access-control-allow-origin")).toBe("*");
    expect(await config.json()).toMatchObject({ currentUser: { username: "e2e-owner" } });

    const preflight = await remote("/api/workspaces", {
      method: "OPTIONS",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const fixture = await createGitFixture(application.runDirectory);
    const document = "Private work from a detached client.\n";
    await Bun.write(join(fixture.repositoryDirectory, "client.txt"), document);
    const hosts = await (await remote("/api/execution-hosts", {}, tokens.access_token)).json() as Array<{ ref: Record<string, string> }>;
    const host = hosts.find(host => host.ref["kind"] === "local");
    if (!host) throw new Error("Local execution host is unavailable.");
    const workspace = await remoteJson<{ id: string }>("/api/workspaces", {
      name: "Detached client workspace",
      directory: fixture.repositoryDirectory,
      executionHost: host.ref,
      serverSettings: { agent: { adapter: "acp", provider: "copilot" } },
    }, tokens.access_token);
    const resource = await remoteJson<{ url: string }>("/api/auth/client-ticket", {
      kind: "resource",
      url: `/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent("client.txt")}`,
    }, tokens.access_token);
    const downloadUrl = new URL(resource.url, application.baseUrl);
    const download = await fetch(downloadUrl, { signal: operationSignal() });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(document);
    const renewed = await remoteJson<Tokens>("/api/auth/token", {
      grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: clientId,
    });
    expect((await remote(`/api/workspaces/${workspace.id}`, {}, renewed.access_token)).status).toBe(200);
    await remoteJson("/api/auth/revoke", { refreshToken: renewed.refresh_token });
    expect((await remote("/api/config", {}, renewed.access_token)).status).toBe(401);
    const revokedDownload = await fetch(downloadUrl, { signal: operationSignal() });
    expect(revokedDownload.status).toBe(401);
    await revokedDownload.body?.cancel();
  } catch (error) {
    console.error(await application.diagnostics());
    throw error;
  } finally {
    try {
      await application.cleanup();
    } finally {
      await staticHost?.stop(true);
    }
  }
});
