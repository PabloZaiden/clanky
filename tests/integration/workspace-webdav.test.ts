/**
 * Regression boundary: real DAV HTTP -> framework auth -> host filesystem.
 * Refactoring the bridge or Core must preserve these observable workflows.
 * Existing explorer tests do not cover DAV/auth/stream cancellation together.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createApiKey, createWebAppServer, sqliteWebAppStore,
  type RuntimeConfig, type UserRecord,
} from "@pablozaiden/webapp/server";
import { createDeviceCredentialsStore } from "@pablozaiden/webapp/cli";
import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { SaxesParser } from "saxes";
import { startWorkspaceWebDav, type WebDavBridge } from "../../src/cli/webdav";
import { parseWorkspaceCommandArgs } from "../../src/cli/workspace";
import { routes } from "../../src/server";
import { DAV_MAX_XML_BYTES } from "../../src/cli/webdav/protocol";
import { setupTestContext, teardownTestContext, testOwnerUser, testWorkspaceId } from "../setup";
import { pollUntil } from "../helpers/polling";

function davProperty(body: string, name: string): string {
  let selected = false;
  let value = "";
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => { if (tag.uri === "DAV:" && tag.local === name) selected = true; });
  parser.on("text", (text) => { if (selected) value += text; });
  parser.on("closetag", (tag) => { if (tag.uri === "DAV:" && tag.local === name) selected = false; });
  parser.write(body).close();
  return value;
}

function runtime(dataDir: string): RuntimeConfig {
  return {
    appName: "Clanky", envPrefix: "CLANKY", host: "127.0.0.1", port: 0, dataDir,
    logLevel: "fatal", logLevelFromEnv: false, inMemoryLogsEnabled: false,
    passkeyDisabled: false, sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" }, development: false,
  };
}

describe("workspace WebDAV", () => {
  let context: Awaited<ReturnType<typeof setupTestContext>>;
  let app: Awaited<ReturnType<ReturnType<typeof createWebAppServer>["start"]>>;
  let baseUrl: string;
  let token: string;
  let tokenId: string;
  let secondaryToken: string;
  let restrictedToken: string;
  const bridges: WebDavBridge[] = [];

  beforeEach(async () => {
    context = await setupTestContext({ useMockBackend: false, initGit: true });
    const store = sqliteWebAppStore({ dataDir: context.dataDir });
    app = await createWebAppServer({
      appName: "Clanky", envPrefix: "CLANKY", runtimeConfig: runtime(context.dataDir),
      web: false, store, auth: { passkeys: true, apiKeys: true, deviceAuth: true }, routes,
    }).start();
    const now = new Date().toISOString();
    const secondary = {
      id: "dav-secondary", username: "dav-secondary", role: "user" as const,
      isOwner: false, isAdmin: false,
    };
    for (const user of [testOwnerUser, secondary]) {
      if (!store.getUserById(user.id)) {
        store.createUser({
          ...user, authVersion: 1, passkeyConfigured: false, createdAt: now, updatedAt: now,
        } satisfies UserRecord);
      }
    }
    const ownerKey = createApiKey(store, testOwnerUser, { name: "DAV owner", scopes: ["*"] });
    token = ownerKey.token;
    tokenId = ownerKey.key.id;
    restrictedToken = createApiKey(store, testOwnerUser, { name: "DAV restricted", scopes: ["unrelated"] }).token;
    secondaryToken = createApiKey(store, secondary, { name: "DAV other user", scopes: ["*"] }).token;
    baseUrl = app.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) await bridge.close();
    if (app) await app.stop(true);
    if (context) await teardownTestContext(context);
  });

  async function bridge(readOnly = false, workspaceId = testWorkspaceId): Promise<WebDavBridge> {
    const command = parseWorkspaceCommandArgs([
      "webdav", workspaceId, ...(readOnly ? ["--read-only"] : []),
    ]);
    if (command.operation !== "webdav") throw new Error("Expected WebDAV command");
    const credentials = createDeviceCredentialsStore({
      appDirectoryName: ".clanky", stateDirectory: () => context.dataDir,
    });
    const result = await startWorkspaceWebDav({
      fetchFn: fetch, envPrefix: "CLANKY",
      environment: { CLANKY_BASE_URL: baseUrl, CLANKY_API_KEY: token }, credentials,
    }, command);
    bridges.push(result);
    return result;
  }

  function urlFor(bridge: WebDavBridge, path: string): string {
    return bridge.origin + path.split("/").map(encodeURIComponent).join("/");
  }

  async function request(bridge: WebDavBridge, path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(urlFor(bridge, path), {
      ...init, headers: {
        authorization: `Basic ${Buffer.from(`${bridge.username}:${bridge.password}`).toString("base64")}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
  }

  test("mount workflow round-trips exact filenames and binary data, saves by rename and supports directories", async () => {
    const dav = await bridge();
    const root = context.workDir;
    const directory = join(root, "new folder");
    expect((await request(dav, directory, { method: "MKCOL" })).status).toBe(201);
    const name = " leading space \u00f1 & %.bin ";
    const path = join(directory, name);
    const bytes = new Uint8Array([0, 1, 255, 128, 0, 10]);
    const put = await request(dav, path, { method: "PUT", body: bytes });
    expect(put.status).toBe(201);
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
    const get = await request(dav, path);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    expect((await request(dav, path, { method: "HEAD" })).headers.get("content-length")).toBe(String(bytes.length));
    const etag = get.headers.get("etag")!;
    expect((await request(dav, path, { headers: { "if-none-match": etag } })).status).toBe(304);
    const range = await request(dav, path, { headers: { range: "bytes=1-3" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe("bytes 1-3/6");
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(bytes.subarray(1, 4));
    const suffix = await request(dav, path, { headers: { range: "bytes=-2" } });
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(bytes.subarray(4));
    const unsatisfiable = await request(dav, path, { headers: { range: "bytes=99-" } });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */6");
    expect((await request(dav, path, { method: "PUT", body: "stale", headers: { "if-match": '"wrong-version"' } })).status).toBe(412);
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
    const properties = await request(dav, path, {
      method: "PROPFIND", headers: { depth: "1" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>',
    });
    expect(properties.status).toBe(207);
    const weakTag = davProperty(await properties.text(), "getetag");
    expect((await request(dav, path, { method: "PUT", body: "new version", headers: { if: `([${weakTag}])` } })).status).toBe(204);
    expect((await request(dav, path, { method: "PUT", body: "stale", headers: { if: `([${weakTag}])` } })).status).toBe(412);
    const listing = await request(dav, directory, {
      method: "PROPFIND", headers: { depth: "1" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:displayname/><D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>',
    });
    expect(listing.status).toBe(207);
    const xml = await listing.text();
    expect(xml).toContain(encodeURIComponent(name));
    const temporary = join(directory, "editor-save.tmp");
    expect((await request(dav, temporary, { method: "PUT", body: "saved" })).status).toBe(201);
    expect((await request(dav, temporary, {
      method: "MOVE", headers: { destination: urlFor(dav, path), overwrite: "T" },
    })).status).toBe(204);
    expect(await Bun.file(path).text()).toBe("saved");
    expect(await Bun.file(temporary).exists()).toBe(false);
    const copied = join(root, "copy.bin");
    expect((await request(dav, path, { method: "COPY", headers: { destination: urlFor(dav, copied) } })).status).toBe(201);
    expect(await Bun.file(copied).text()).toBe("saved");
    expect((await request(dav, path, { method: "COPY", headers: { destination: urlFor(dav, copied), overwrite: "F" } })).status).toBe(412);
    const tree = join(root, "copied folder");
    expect((await request(dav, directory, { method: "COPY", headers: { destination: urlFor(dav, tree) } })).status).toBe(201);
    expect(await Bun.file(join(tree, name)).text()).toBe("saved");
    expect((await request(dav, copied, { method: "DELETE" })).status).toBe(204);
    expect(await Bun.file(copied).exists()).toBe(false);
    const empty = join(root, "empty.txt");
    expect((await request(dav, empty, { method: "PUT" })).status).toBe(201);
    expect(await Bun.file(empty).size).toBe(0);
    expect((await request(dav, tree, { method: "DELETE" })).status).toBe(204);
    expect(await Bun.file(join(tree, name)).exists()).toBe(false);
  });

  test("large streamed binary transfers and ranges preserve every byte", async () => {
    const dav = await bridge();
    const path = join(context.workDir, "large.bin");
    const bytes = new Uint8Array(10 * 1_024 * 1_024).fill(177);
    bytes[1_023] = 0;
    bytes[65_536] = 255;
    bytes[bytes.length - 1] = 31;
    expect((await request(dav, path, { method: "PUT", body: new Blob([bytes]).stream() })).status).toBe(201);
    const downloaded = await request(dav, path);
    expect(downloaded.status).toBe(200);
    expect((await request(dav, path, { method: "HEAD" })).headers.get("content-length")).toBe(String(bytes.length));
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
    const partial = await request(dav, path, { headers: { range: "bytes=65000-66000" } });
    expect(partial.status).toBe(206);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.subarray(65_000, 66_001));
    // External HTTP contract: strong/date validators permit a range; a weak
    // If-Range cannot do so. No existing workflow covers these three cases.
    const etag = downloaded.headers.get("etag")!;
    const validated = await request(dav, path, { headers: { range: "bytes=1-3", "if-range": etag } });
    expect(validated.status).toBe(206);
    expect(validated.headers.get("etag")).toBe(etag);
    expect(new Uint8Array(await validated.arrayBuffer())).toEqual(bytes.subarray(1, 4));
    const dated = await request(dav, path, {
      headers: { range: "bytes=1-3", "if-range": downloaded.headers.get("last-modified")! },
    });
    expect(dated.status).toBe(206);
    expect(new Uint8Array(await dated.arrayBuffer())).toEqual(bytes.subarray(1, 4));
    const weak = await request(dav, path, { headers: { range: "bytes=1-3", "if-range": `W/${etag}` } });
    expect(weak.status).toBe(200);
    expect(new Uint8Array(await weak.arrayBuffer())).toEqual(bytes);
    const changed = await request(dav, path, { headers: { range: "bytes=1-3", "if-range": '"old"' } });
    expect(changed.status).toBe(200);
    expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bytes);
  });

  test("conditional COPY preserves the existing destination when the source validator fails", async () => {
    const dav = await bridge();
    const source = join(context.workDir, "changed-source.txt");
    const destination = join(context.workDir, "preserved.txt");
    await Bun.write(source, "current source");
    await Bun.write(destination, "original");
    expect((await request(dav, source, {
      method: "COPY", headers: { destination: urlFor(dav, destination), "if-match": '"old-source"' },
    })).status).toBe(412);
    expect(await Bun.file(destination).text()).toBe("original");
    expect((await readdir(context.workDir)).filter((name) => name.startsWith(".clanky-upload-"))).toEqual([]);
  });

  test("initial directory does not confine host access or existing symlinks", async () => {
    const dav = await bridge();
    const outside = join(context.dataDir, "outside files");
    await mkdir(outside);
    const path = join(outside, "note.txt");
    expect((await request(dav, path, { method: "PUT", body: "outside" })).status).toBe(201);
    await symlink(outside, join(context.workDir, "outside-link"));
    expect(await (await request(dav, join(context.workDir, "outside-link", "note.txt"))).text()).toBe("outside");
    const listing = await request(dav, outside, { method: "PROPFIND", headers: { depth: "1" } });
    expect(listing.status).toBe(207);
    expect(await listing.text()).toContain("note.txt");
    const copied = join(context.workDir, "outside-copy");
    expect((await request(dav, join(context.workDir, "outside-link"), {
      method: "COPY", headers: { destination: urlFor(dav, copied) },
    })).status).toBe(201);
    expect(await Bun.file(join(copied, "note.txt")).text()).toBe("outside");
    expect((await request(dav, join(copied, "note.txt"), { method: "PUT", body: "independent copy" })).status).toBe(204);
    expect(await Bun.file(path).text()).toBe("outside");
    expect((await request(dav, path, { method: "DELETE" })).status).toBe(204);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("local credentials, authorities and controller ownership remain enforced", async () => {
    const dav = await bridge();
    expect((await fetch(dav.url, { method: "PROPFIND", headers: { depth: "0" } })).status).toBe(401);
    expect((await request(dav, context.workDir, { method: "OPTIONS", headers: { authorization: "Basic invalid" } })).status).toBe(401);
    expect((await request(dav, context.workDir, { method: "OPTIONS", headers: { origin: "https://example.invalid" } })).status).toBe(403);
    expect((await request(dav, context.workDir, { method: "OPTIONS", headers: { host: "example.invalid" } })).status).toBe(403);
    const options = await request(dav, context.workDir, { method: "OPTIONS" });
    expect(options.headers.get("dav")).toBe("1, 2");
    const endpoint = `${baseUrl}/api/workspaces/${testWorkspaceId}/files/filesystem`;
    expect((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: '{"operation":"info"}' })).status).toBe(401);
    expect((await fetch(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${secondaryToken}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "stat", path: context.workDir }),
    })).status).toBe(404);
    expect((await fetch(endpoint, {
      method: "POST", headers: { authorization: `Bearer ${restrictedToken}`, "content-type": "application/json" },
      body: '{"operation":"info"}',
    })).status).toBe(403);
    const path = join(context.workDir, "source.txt");
    await Bun.write(path, "source");
    expect((await request(dav, path, { method: "COPY", headers: { destination: "https://example.invalid/source.txt" } })).status).toBe(502);
    expect(await Bun.file(path).text()).toBe("source");
  });

  test("revoked controller credentials fail closed rather than becoming local DAV login failures", async () => {
    const dav = await bridge();
    const path = join(context.workDir, "revoked.txt");
    await Bun.write(path, "original");
    expect((await fetch(`${baseUrl}/api/api-keys/${tokenId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    })).status).toBe(200);
    expect((await request(dav, path, { method: "PUT", body: "unauthorized" })).status).toBe(502);
    expect(await Bun.file(path).text()).toBe("original");
    bridges.splice(bridges.indexOf(dav), 1);
    await expect(dav.close()).rejects.toMatchObject({ status: 502 });
    await expect(fetch(dav.url)).rejects.toThrow();
  });

  test("Unicode initial directories work and deleted workspaces stop authorizing writes", async () => {
    const alternate = join(context.dataDir, "\u4e2d\u6587 revision");
    await symlink(context.workDir, alternate);
    const original = await (await fetch(`${baseUrl}/api/workspaces/${testWorkspaceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json() as { executionHostBinding: { host: object }; serverSettings: object };
    const created = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Unicode DAV", directory: alternate, workspaceType: "directory",
        executionHost: original.executionHostBinding.host, serverSettings: original.serverSettings,
      }),
    });
    expect(created.status).toBe(201);
    const workspace = await created.json() as { id: string; directory: string };
    expect(workspace.directory).toBe(alternate);
    const dav = await bridge(false, workspace.id);
    const path = join(alternate, "revision.txt");
    expect((await request(dav, path, { method: "PUT", body: "original" })).status).toBe(201);
    expect((await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${token}` },
    })).status).toBe(200);
    expect((await request(dav, path, { method: "PUT", body: "deleted target" })).status).toBe(404);
    expect(await Bun.file(path).text()).toBe("original");
    bridges.splice(bridges.indexOf(dav), 1);
    await expect(dav.close()).rejects.toMatchObject({ status: 404 });
    await expect(fetch(dav.url)).rejects.toThrow();
  });

  test("read-only flag refuses every filesystem mutation while permitting reads", async () => {
    const dav = await bridge(true);
    const path = join(context.workDir, "read.txt");
    await Bun.write(path, "original");
    expect(await (await request(dav, path)).text()).toBe("original");
    for (const method of ["PUT", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK", "UNLOCK", "PROPPATCH"]) {
      expect((await request(dav, path, { method })).status).toBe(403);
    }
    expect(await Bun.file(path).text()).toBe("original");
  });

  test("DAV locks coordinate separate bridges, refresh, and release on shutdown", async () => {
    const first = await bridge();
    const second = await bridge();
    const path = join(context.workDir, "locked.txt");
    const lock = await request(first, path, {
      method: "LOCK", headers: { depth: "0" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>editor</D:href></D:owner></D:lockinfo>',
    });
    expect(lock.status).toBe(201);
    const lockToken = lock.headers.get("lock-token")!;
    expect((await request(second, path, { method: "PUT", body: "blocked" })).status).toBe(423);
    const workspace = await (await fetch(`${baseUrl}/api/workspaces/${testWorkspaceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json() as { executionHostBinding: { host: { kind: string; nodeId: string } } };
    const host = workspace.executionHostBinding.host;
    expect((await fetch(`${baseUrl}/api/execution-hosts/${host.kind}/${host.nodeId}/files/filesystem/content?${new URLSearchParams({ path })}`, {
      method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "blocked through host route",
    })).status).toBe(423);
    expect((await request(first, path, { method: "PUT", body: "saved", headers: { if: `(${lockToken})` } })).status).toBe(204);
    expect((await request(first, path, { method: "LOCK", headers: { if: `(${lockToken})` } })).status).toBe(200);
    expect((await request(second, path, { method: "PUT", body: "not a token", headers: { if: `(Not ${lockToken})` } })).status).toBe(412);
    expect((await request(first, path, { method: "UNLOCK", headers: { "lock-token": lockToken } })).status).toBe(204);
    expect((await request(second, path, { method: "PUT", body: "unlocked" })).status).toBe(204);
    expect((await request(first, path, {
      method: "LOCK", body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    })).status).toBe(200);
    await first.close();
    expect((await request(second, path, { method: "PUT", body: "after shutdown" })).status).toBe(204);
    expect(await Bun.file(path).text()).toBe("after shutdown");
    await expect(fetch(first.url)).rejects.toThrow();
  });

  test("interrupted PUT preserves destination and cleans host-side staging", async () => {
    const dav = await bridge();
    const path = join(context.workDir, "interrupt.bin");
    await Bun.write(path, "original");
    const controller = new AbortController();
    const gate = Promise.withResolvers<void>();
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        if (!sent) { sent = true; output.enqueue(new Uint8Array(64 * 1_024)); }
        else { await gate.promise; output.close(); }
      },
      cancel() { gate.resolve(); },
    });
    const upload = request(dav, path, { method: "PUT", body: stream, signal: controller.signal });
    const observed = await pollUntil(
      async () => (await readdir(context.workDir)).filter((name) => name.startsWith(".clanky-upload-")),
      (files) => files.length > 0,
      { description: "DAV upload staging file to appear", timeoutMs: 5_000 },
    );
    expect(observed.length).toBe(1);
    controller.abort();
    gate.resolve();
    await expect(upload).rejects.toThrow();
    await pollUntil(
      async () => (await readdir(context.workDir)).filter((name) => name.startsWith(".clanky-upload-")),
      (files) => files.length === 0,
      { description: "aborted DAV upload staging to be cleaned", timeoutMs: 5_000 },
    );
    expect(await Bun.file(path).text()).toBe("original");
  });

  test("32 live streaming requests bound listener admission and cancellation releases staging", async () => {
    const dav = await bridge();
    const uploads: Promise<Response>[] = [];
    const controllers: AbortController[] = [];
    const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
    try {
      for (let index = 0; index < 32; index += 1) {
        const controller = new AbortController();
        const gate = Promise.withResolvers<void>();
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          async pull(output) {
            if (!sent) { sent = true; output.enqueue(new Uint8Array(1_024)); }
            else { await gate.promise; output.close(); }
          },
          cancel() { gate.resolve(); },
        });
        controllers.push(controller);
        gates.push(gate);
        uploads.push(request(dav, join(context.workDir, `quota-${String(index)}.bin`), {
          method: "PUT", body: stream, signal: controller.signal,
        }));
      }
      await pollUntil(
        async () => (await readdir(context.workDir)).filter((name) => name.startsWith(".clanky-upload-")).length,
        (count) => count === 32,
        { description: "32 DAV streams to own staging resources", timeoutMs: 5_000 },
      );
      expect((await request(dav, context.workDir, { method: "OPTIONS" })).status).toBe(503);
    } finally {
      for (const controller of controllers) controller.abort();
      for (const gate of gates) gate.resolve();
      await Promise.allSettled(uploads);
    }
    await pollUntil(
      async () => (await readdir(context.workDir)).filter((name) => name.startsWith(".clanky-upload-")).length,
      (count) => count === 0,
      { description: "all canceled DAV streams to release staging", timeoutMs: 5_000 },
    );
    expect((await request(dav, context.workDir, { method: "OPTIONS" })).status).toBe(200);
  }, 15_000);

  test("shared and recursive locks require each affected resource token but do not prevent copying", async () => {
    const first = await bridge();
    const second = await bridge();
    const directory = join(context.workDir, "locked folder");
    expect((await request(first, directory, { method: "MKCOL" })).status).toBe(201);
    const one = join(directory, "one.txt");
    const two = join(directory, "two.txt");
    const shared = '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
    const lockOne = await request(first, one, { method: "LOCK", headers: { depth: "0" }, body: shared });
    const tokenOne = lockOne.headers.get("lock-token")!;
    const another = await request(second, one, { method: "LOCK", headers: { depth: "0" }, body: shared });
    const tokenAnother = another.headers.get("lock-token")!;
    const lockTwo = await request(first, two, { method: "LOCK", headers: { depth: "0" }, body: shared });
    const tokenTwo = lockTwo.headers.get("lock-token")!;
    expect(another.status).toBe(200);
    expect((await request(second, one, { method: "PUT", body: "shared", headers: { if: `(${tokenAnother})` } })).status).toBe(204);
    const copy = join(context.workDir, "unlocked-copy.txt");
    expect((await request(second, one, { method: "COPY", headers: { destination: urlFor(second, copy) } })).status).toBe(201);
    expect(await Bun.file(copy).text()).toBe("shared");
    expect((await request(first, directory, {
      method: "DELETE", headers: { if: `<${urlFor(first, one)}> (${tokenOne})` },
    })).status).toBe(423);
    expect((await request(first, directory, {
      method: "DELETE", headers: { if: `<${urlFor(first, one)}> (${tokenOne}) <${urlFor(first, two)}> (${tokenTwo})` },
    })).status).toBe(204);
    expect(await Bun.file(one).exists()).toBe(false);
    expect(await Bun.file(two).exists()).toBe(false);
  });

  test("lock expiration restores write access within the negotiated lease", async () => {
    const first = await bridge();
    const second = await bridge();
    const path = join(context.workDir, "expiring.txt");
    const lease = await request(first, path, {
      method: "LOCK", headers: { depth: "0", timeout: "Second-1" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(lease.status).toBe(201);
    expect(davProperty(await lease.text(), "timeout")).toBe("Second-1");
    expect((await request(second, path, { method: "PUT", body: "blocked" })).status).toBe(423);
    await pollUntil(
      async () => (await request(second, path, { method: "PUT", body: "after expiry" })).status,
      (status) => status === 204,
      { description: "DAV lease expiration to permit writes", timeoutMs: 5_000 },
    );
    expect(await Bun.file(path).text()).toBe("after expiry");
  });

  test("10,000-entry limit rejects excessive recursive work without truncation or partial deletion", async () => {
    const dav = await bridge();
    const directory = join(context.workDir, "many files");
    await mkdir(directory);
    for (let offset = 0; offset < 10_000; offset += 250) {
      await Promise.all(Array.from({ length: 250 }, (_, index) => Bun.write(join(directory, `${String(offset + index)}.txt`), "")));
    }
    const listing = await request(dav, directory, { method: "PROPFIND", headers: { depth: "1" } });
    expect(listing.status).toBe(207);
    expect((await listing.text()).match(/<D:response>/g)?.length).toBe(10_001);
    await Bun.write(join(directory, "extra.txt"), "retain");
    expect((await request(dav, directory, { method: "PROPFIND", headers: { depth: "1" } })).status).toBe(507);
    expect((await request(dav, directory, { method: "DELETE" })).status).toBe(507);
    expect(await Bun.file(join(directory, "extra.txt")).text()).toBe("retain");
    const destination = join(context.workDir, "too big");
    expect((await request(dav, directory, { method: "COPY", headers: { destination: urlFor(dav, destination) } })).status).toBe(507);
    expect(await Bun.file(join(destination, "extra.txt")).exists()).toBe(false);
  });

  test("XML parsing is namespace-aware, rejects entities and enforces concrete limits", async () => {
    const dav = await bridge();
    const path = context.workDir;
    expect((await request(dav, path, {
      method: "PROPFIND", headers: { depth: "0" },
      body: '<p:propfind xmlns:p="DAV:"><p:prop><p:resourcetype/></p:prop></p:propfind>',
    })).status).toBe(207);
    expect((await request(dav, path, {
      method: "PROPFIND", headers: { depth: "0" },
      body: '<!DOCTYPE propfind [<!ENTITY external SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:">&external;</propfind>',
    })).status).toBe(400);
    expect((await request(dav, path, {
      method: "PROPFIND", headers: { depth: "0" }, body: "x".repeat(DAV_MAX_XML_BYTES + 1),
    })).status).toBe(413);
    expect((await request(dav, path, {
      method: "PROPFIND", headers: { depth: "0" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop>' + "<x>".repeat(30) + "</x>".repeat(30) + "</D:prop></D:propfind>",
    })).status).toBe(207);
    expect((await request(dav, path, {
      method: "PROPFIND", headers: { depth: "0" }, body: "<x>".repeat(33) + "</x>".repeat(33),
    })).status).toBe(413);
    expect((await request(dav, path, { method: "PROPFIND", headers: { depth: "infinity" } })).status).toBe(403);
    const expanded = '<D:propertyupdate xmlns:D="DAV:" xmlns:P="urn:' + "a".repeat(20_000) + '">'
      + "<D:set><D:prop>" + Array.from({ length: 900 }, (_, index) => `<P:a${String(index)}/>`).join("")
      + "</D:prop></D:set></D:propertyupdate>";
    expect((await request(dav, path, { method: "PROPPATCH", body: expanded })).status).toBe(507);
  });
});
