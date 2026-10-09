/**
 * Real Mesh boundary: DAV and source-context chat creation must use the selected
 * worker binding, reject target changes, and never fall back to local files.
 * Local DAV and Mesh exec scenarios do not cover these combined contracts.
 */

import { expect, test } from "bun:test";
import { createDeviceCredentialsStore } from "@pablozaiden/webapp/cli";
import { open } from "node:fs/promises";
import { startWorkspaceWebDav, type WebDavBridge } from "../../src/cli/webdav";
import type { Chat } from "../../src/shared/chat";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, startMeshNode, stopMeshNode,
  type ManagedMeshNode,
} from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";

test("workspace WebDAV and new chats remain pinned to their Mesh execution target", async () => {
  const command = await compiledClankyCommand();
  const nodes: ManagedMeshNode[] = [];
  let dav: WebDavBridge | undefined;
  let readOnly: WebDavBridge | undefined;
  try {
    const controller = await startMeshNode({ role: "controller", command });
    nodes.push(controller);
    const worker = await startMeshNode({ role: "worker", command });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);
    const hosts = await pollUntil(
      async () => (await meshJsonRequest<Array<{ ref: { kind: string; nodeId?: string } }>>(
        controller, "/api/execution-hosts",
      )).body,
      (items) => items.some((host) => host.ref.kind === "mesh"),
      { description: "DAV worker to be discoverable", timeoutMs: 10_000 },
    );
    const workerRef = hosts.find((host) => host.ref.kind === "mesh")!.ref;
    const localRef = hosts.find((host) => host.ref.kind === "local")!.ref;
    const key = await meshJsonRequest<{ token: string }>(controller, "/api/api-keys", {
      body: { name: "DAV integration", scopes: ["*"] },
    });
    expect(key.status).toBe(200);
    expect(typeof key.body.token).toBe("string");
    const workspace = await meshJsonRequest<{ id: string }>(controller, "/api/workspaces", {
      body: {
        name: "DAV Mesh", directory: worker.dataDir, workspaceType: "directory",
        executionHost: workerRef, serverSettings: { agent: { adapter: "acp", provider: "opencode" } },
      },
    });
    expect(workspace.status).toBe(201);
    const sourceChat = await meshJsonRequest<Chat>(controller, "/api/chats", {
      body: {
        workspaceId: workspace.body.id,
        useWorktree: false,
        model: { providerID: "opencode", modelID: "mesh-context-fixture", variant: "" },
      },
    });
    expect(sourceChat.status).toBe(201);
    const input = {
      fetchFn: fetch, envPrefix: "CLANKY",
      environment: { CLANKY_BASE_URL: controller.baseUrl, CLANKY_API_KEY: key.body.token },
      credentials: createDeviceCredentialsStore({
        appDirectoryName: ".clanky", stateDirectory: () => controller.dataDir,
      }),
    };
    dav = await startWorkspaceWebDav(input, {
      operation: "webdav", workspace: workspace.body.id, readOnly: false,
    });
    const bridge = dav;
    const url = (path: string) => bridge.origin + path.split("/").map(encodeURIComponent).join("/");
    const request = async (path: string, init: RequestInit = {}) => await fetch(url(path), {
      ...init, headers: {
        authorization: `Basic ${Buffer.from(`${bridge.username}:${bridge.password}`).toString("base64")}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    });
    const directory = `${worker.dataDir}/dav-folder`;
    const path = `${directory}/binary.bin`;
    const copy = `${directory}/copy.bin`;
    expect((await request(directory, { method: "MKCOL" })).status).toBe(201);
    const listingNames = Array.from({ length: 12 }, (_, index) => `entry-${String(index).padStart(2, "0")}.txt`);
    await Promise.all(listingNames.map(async (name) => await Bun.write(`${directory}/${name}`, name)));
    const listings = await Promise.all(Array.from({ length: 3 }, async () => await request(directory, {
      method: "PROPFIND",
      headers: { depth: "1", "content-type": "application/xml" },
      body: '<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>',
    })));
    expect(listings.map((response) => response.status)).toEqual([207, 207, 207]);
    for (const response of listings) {
      const xml = await response.text();
      for (const name of listingNames) expect(xml).toContain(encodeURIComponent(name));
    }

    const bytes = new Uint8Array(10 * 1_024 * 1_024).fill(193);
    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    expect((await request(path, { method: "PUT", body: new Blob([bytes]).stream() })).status).toBe(201);
    expect(new Uint8Array(await (await request(path)).arrayBuffer())).toEqual(bytes);
    expect((await request(path, { method: "COPY", headers: { destination: url(copy) } })).status).toBe(201);
    expect(new Uint8Array(await (await request(copy)).arrayBuffer())).toEqual(bytes);
    if (process.platform !== "win32") {
      // Sparse POSIX fixture: suffix/late reads must not hash or transfer a
      // 100 GiB prefix. Small ranges cannot detect that regression. The bounded
      // request deadline is the contract, not a synchronization delay.
      const sparse = `${directory}/sparse \u00f1 ' &.bin`;
      const size = 100 * 1_024 ** 3;
      const tail = new Uint8Array(2 * 1_024 ** 2 + 137).fill(221);
      tail[0] = 0;
      tail[tail.length - 2] = 255;
      tail[tail.length - 1] = 31;
      const file = await open(sparse, "w");
      try {
        await file.truncate(size);
        await file.write(tail, 0, tail.length, size - tail.length);
      } finally { await file.close(); }
      const suffix = await request(sparse, {
        headers: { range: "bytes=-2" }, signal: AbortSignal.timeout(5_000),
      });
      expect(suffix.status).toBe(206);
      expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 2}-${size - 1}/${size}`);
      expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(tail.subarray(-2));
      const start = size - tail.length + 91;
      const late = await request(sparse, {
        headers: { range: `bytes=${start}-${size - 1}` }, signal: AbortSignal.timeout(5_000),
      });
      expect(late.status).toBe(206);
      expect(new Uint8Array(await late.arrayBuffer())).toEqual(tail.subarray(91));
    }
    expect((await meshJsonRequest(controller, `/api/workspaces/${workspace.body.id}`, {
      method: "PUT", body: { executionHost: localRef },
    })).status).toBe(200);
    const staleNewChat = await meshJsonRequest(controller, `/api/chats/${sourceChat.body.config.id}/new-here`, {
      body: {},
    });
    expect(staleNewChat.status).toBe(409);
    const chats = await meshJsonRequest<Array<{ config: { id: string } }>>(
      controller,
      `/api/chats?workspaceId=${encodeURIComponent(workspace.body.id)}`,
    );
    expect(chats.status).toBe(200);
    expect(chats.body.map((chat) => chat.config.id)).toEqual([sourceChat.body.config.id]);
    expect((await request(path, { method: "PUT", body: "wrong host" })).status).toBe(409);
    expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(bytes);
    await expect(dav.close()).rejects.toMatchObject({ status: 409 });
    dav = undefined;
    expect((await meshJsonRequest(controller, `/api/workspaces/${workspace.body.id}`, {
      method: "PUT", body: { executionHost: workerRef },
    })).status).toBe(200);
    readOnly = await startWorkspaceWebDav(input, {
      operation: "webdav", workspace: workspace.body.id, readOnly: true,
    });
    worker.child.kill();
    await worker.child.exited;
    // Both processes share this test filesystem; a local fallback would succeed.
    expect(await Bun.file(path).exists()).toBe(true);
    const response = await fetch(readOnly.origin + path.split("/").map(encodeURIComponent).join("/"), {
      headers: {
        authorization: `Basic ${Buffer.from(`${readOnly.username}:${readOnly.password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status).toBe(503);
    await readOnly.close();
    await expect(fetch(readOnly.url)).rejects.toThrow();
    readOnly = undefined;
  } finally {
    const cleanup = await Promise.allSettled([
      ...(dav ? [dav.close()] : []), ...(readOnly ? [readOnly.close()] : []),
    ]);
    for (const node of nodes.reverse()) await stopMeshNode(node);
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}, 60_000);
