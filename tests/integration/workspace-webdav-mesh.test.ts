/**
 * Real Mesh boundary: DAV must use the selected worker's existing filesystem
 * and exec protocols, reject target changes, and never fall back to local files.
 * Local DAV and Mesh exec scenarios do not cover this combined contract.
 */

import { expect, test } from "bun:test";
import { createDeviceCredentialsStore } from "@pablozaiden/webapp/cli";
import { startWorkspaceWebDav, type WebDavBridge } from "../../src/cli/webdav";
import {
  compiledClankyCommand, enrollMeshWorker, meshJsonRequest, startMeshNode, stopMeshNode,
  type ManagedMeshNode,
} from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";

test("workspace WebDAV uses Mesh streaming and exec, pins its host and refuses local fallback", async () => {
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
        executionHost: workerRef, serverSettings: { agent: { provider: "opencode" } },
      },
    });
    expect(workspace.status).toBe(201);
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
    const bytes = new Uint8Array(10 * 1_024 * 1_024).fill(193);
    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    expect((await request(path, { method: "PUT", body: new Blob([bytes]).stream() })).status).toBe(201);
    expect(new Uint8Array(await (await request(path)).arrayBuffer())).toEqual(bytes);
    expect((await request(path, { method: "COPY", headers: { destination: url(copy) } })).status).toBe(201);
    expect(new Uint8Array(await (await request(copy)).arrayBuffer())).toEqual(bytes);
    expect((await meshJsonRequest(controller, `/api/workspaces/${workspace.body.id}`, {
      method: "PUT", body: { executionHost: localRef },
    })).status).toBe(200);
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
