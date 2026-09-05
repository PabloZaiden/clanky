import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initializeGitRepository } from "../helpers/git-fixtures";
import { pollUntil } from "../helpers/polling";

interface MeshMember {
  nodeId: string;
  endpoint: string | null;
  transport: "http" | "https";
  instanceName: string | null;
  status: string;
}

interface MeshLink {
  linkId: string;
  members: MeshMember[];
}

interface MeshPairingRequest {
  id: string;
  remoteApproval?: {
    fingerprint: string;
  };
}

interface MeshStatus {
  node: {
    nodeId: string;
    meshEndpoint?: string | null;
    execution?: {
      repositoriesBasePath: string | null;
      preferredModel: {
        providerID: string;
        modelID: string;
        variant: string;
      } | null;
      acceptRemoteExecution: boolean;
      revision: number;
    };
  };
  links: MeshLink[];
  pendingPairingRequests: MeshPairingRequest[];
}

interface MeshNodeProcess {
  name: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  process: ReturnType<typeof Bun.spawn>;
  output: {
    done: Promise<void>;
    read: () => string;
  };
  stopped: boolean;
}

interface MeshNodeOptions {
  mockAcp?: boolean;
  remoteOnly?: boolean;
}

interface ApiResult {
  status: number;
  body: unknown;
}

let meshNodes: MeshNodeProcess[] = [];
let meshDataDirs: string[] = [];
let meshRepositories: string[] = [];

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a mesh test port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function captureOutput(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  read: () => string;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    while (true) {
      const { done: isDone, value } = await reader.read();
      if (isDone) {
        break;
      }
      output = `${output}${decoder.decode(value, { stream: true })}`.slice(-12_000);
    }
    output = `${output}${decoder.decode()}`.slice(-12_000);
  })();
  return {
    done,
    read: () => output,
  };
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  await pollUntil(
    async () => {
      try {
        return { ready: await predicate() };
      } catch (error) {
        return { ready: false, error: String(error) };
      }
    },
    (observation) => observation.ready,
    {
      description: message,
      timeoutMs,
      formatLastObserved: (observation) => observation.error
        ? `ready=false; error=${observation.error}`
        : `ready=${observation.ready}`,
    },
  );
}

async function startMeshNode(
  name: string,
  dataDir: string,
  existingPort?: number,
  options: MeshNodeOptions = {},
): Promise<MeshNodeProcess> {
  const port = existingPort ?? await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const child = Bun.spawn([process.execPath, "src/index.ts", "serve"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLANKY_DATA_DIR: dataDir,
      CLANKY_DISABLE_PASSKEY: "true",
      CLANKY_HOST: "127.0.0.1",
      CLANKY_LOG_LEVEL: process.env["CLANKY_TEST_MESH_LOG_LEVEL"] ?? "fatal",
      CLANKY_MOCK_ACP: options.mockAcp ? "true" : "false",
      CLANKY_PORT: String(port),
      CLANKY_PUBLIC_BASE_URL: baseUrl,
      CLANKY_REMOTE_ONLY: options.remoteOnly ? "true" : "false",
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const output = captureOutput(child.stderr);
  const node: MeshNodeProcess = {
    name,
    port,
    baseUrl,
    dataDir,
    process: child,
    output,
    stopped: false,
  };

  try {
    await waitForCondition(
      async () => {
        const response = await fetch(`${baseUrl}/api/health`);
        return response.ok;
      },
      `${name} did not become healthy.`,
    );
    return node;
  } catch (error) {
    child.kill();
    await child.exited;
    await output.done;
    throw new Error(`${String(error)} Logs: ${output.read()}`);
  }
}

async function stopMeshNode(node: MeshNodeProcess): Promise<void> {
  if (node.stopped) {
    return;
  }
  node.stopped = true;
  node.process.kill();
  await node.process.exited;
  await node.output.done;
}

async function request(
  node: MeshNodeProcess,
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("origin", node.baseUrl);
  }
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${node.baseUrl}${path}`, {
    ...init,
    method,
    headers,
  });
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSON from ${node.name}${path}: ${String(error)}`);
    }
  }
  return { status: response.status, body };
}

async function postJson(
  node: MeshNodeProcess,
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  return await request(node, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getStatus(node: MeshNodeProcess): Promise<MeshStatus> {
  const result = await request(node, "/api/mesh/status");
  if (result.status !== 200) {
    throw new Error(`${node.name} returned ${String(result.status)} for mesh status: ${JSON.stringify(result.body)}`);
  }
  return result.body as MeshStatus;
}

function getLink(status: MeshStatus): MeshLink {
  const link = status.links[0];
  if (!link) {
    throw new Error("Mesh link is not available.");
  }
  return link;
}

async function pairNodes(joiner: MeshNodeProcess, target: MeshNodeProcess): Promise<void> {
  const start = await postJson(joiner, "/api/mesh/pairing-requests", {
    targetEndpoint: target.baseUrl,
  });
  expect(start.status).toBe(200);
  const startStatus = (start.body as { status: MeshStatus }).status;
  const request = [...startStatus.pendingPairingRequests].reverse()[0];
  if (!request) {
    throw new Error(`${joiner.name} did not create a pairing request.`);
  }

  await waitForCondition(async () => {
    const status = await getStatus(target);
    return status.pendingPairingRequests.some((candidate) => candidate.id === request.id);
  }, `${target.name} did not receive ${joiner.name}'s pairing request.`);

  const approval = await postJson(
    target,
    `/api/mesh/pairing-requests/${request.id}/approve`,
    {},
  );
  expect(approval.status).toBe(200);

  let fingerprint = "";
  await waitForCondition(async () => {
    const status = await getStatus(joiner);
    const pending = status.pendingPairingRequests.find((candidate) => candidate.id === request.id);
    fingerprint = pending?.remoteApproval?.fingerprint ?? "";
    return fingerprint.length > 0;
  }, `${joiner.name} did not receive the pairing approval.`);

  const completion = await postJson(
    joiner,
    `/api/mesh/pairing-requests/${request.id}/complete`,
    { fingerprint },
  );
  expect(completion.status).toBe(200);
}

async function waitForMemberConvergence(
  nodes: MeshNodeProcess[],
  expectedMemberCount: number,
): Promise<MeshStatus[]> {
  let statuses: MeshStatus[] = [];
  await waitForCondition(async () => {
    statuses = await Promise.all(nodes.map((node) => getStatus(node)));
    return statuses.every((status) => {
      const link = status.links[0];
      return link?.members.length === expectedMemberCount
        && link.members.every((member) => member.endpoint !== null)
        && new Set(link.members.map((member) => member.endpoint)).size === expectedMemberCount;
    });
  }, `The ${String(expectedMemberCount)} Mesh members did not converge.`);
  return statuses;
}

describe("three-process mesh cluster", () => {
  afterEach(async () => {
    for (const node of meshNodes) {
      await stopMeshNode(node);
    }
    for (const dataDir of meshDataDirs) {
      await rm(dataDir, { recursive: true, force: true });
    }
    for (const repository of meshRepositories) {
      await rm(repository, { recursive: true, force: true });
    }
    meshNodes = [];
    meshDataDirs = [];
    meshRepositories = [];
  });

  test("pairs, propagates membership, and survives a peer restart", async () => {
    for (const name of ["A", "B", "C"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-cluster-${name.toLowerCase()}-`)));
    }
    for (const [index, name] of ["A", "B", "C"].entries()) {
      meshNodes.push(await startMeshNode(name, meshDataDirs[index]!));
    }

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });
      expect(result.status).toBe(200);
    }

    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;
    const nodeC = meshNodes[2]!;
    await pairNodes(nodeA, nodeB);
    await pairNodes(nodeC, nodeB);

    const converged = await waitForMemberConvergence(meshNodes, 3);
    expect(new Set(getLink(converged[0]!).members.map((member) => member.endpoint))).toEqual(
      new Set(meshNodes.map((node) => node.baseUrl)),
    );

    expect((await request(nodeA, "/api/mesh/conflicts")).status).toBe(404);
    expect((await request(nodeA, "/api/mesh/takeover")).status).toBe(404);

    const restartedB = nodeB;
    await stopMeshNode(restartedB);
    meshNodes[1] = await startMeshNode("B-restarted", restartedB.dataDir, restartedB.port);
    const restartedStatus = await getStatus(meshNodes[1]!);
    expect(getLink(restartedStatus).members).toHaveLength(3);
    expect(getLink(restartedStatus).members.map((member) => member.instanceName).sort()).toEqual([
      "Instance A",
      "Instance B",
      "Instance C",
    ]);
  });

  test("preserves the direct pairing route when a peer advertises another endpoint", async () => {
    for (const name of ["A", "B"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-asymmetric-${name.toLowerCase()}-`)));
    }
    meshNodes.push(await startMeshNode("A", meshDataDirs[0]!));
    meshNodes.push(await startMeshNode("B", meshDataDirs[1]!));
    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });

      expect(result.status).toBe(200);
    }

    const advertisedEndpoint = `https://localhost:${String(nodeB.port)}`;
    const endpointResult = await postJson(nodeB, "/api/mesh/endpoint", {
      meshEndpoint: advertisedEndpoint,
    });
    expect(endpointResult.status).toBe(200);
    expect((await getStatus(nodeB)).node.meshEndpoint).toBe(advertisedEndpoint);

    await pairNodes(nodeA, nodeB);
    const nodeBId = (await getStatus(nodeB)).node.nodeId;
    await waitForCondition(async () => {
      const status = await getStatus(nodeA);
      return getLink(status).members.some(
        (member) => member.nodeId === nodeBId
          && member.endpoint === nodeB.baseUrl
          && member.transport === "http",
      );
    }, "The initiating node did not preserve the direct pairing route.");

    const propagated = await postJson(nodeB, "/api/mesh/endpoint", {
      meshEndpoint: advertisedEndpoint,
    });
    expect(propagated.status).toBe(200);
    await waitForCondition(async () => {
      const status = await getStatus(nodeA);
      return getLink(status).members.find((member) => member.nodeId === nodeBId)?.endpoint === nodeB.baseUrl;
    }, "Membership propagation replaced the direct pairing route.");

    const restartedB = nodeB;
    await stopMeshNode(restartedB);
    meshNodes[1] = await startMeshNode("B-restarted", restartedB.dataDir, restartedB.port);
    const restartedEndpoint = await postJson(meshNodes[1]!, "/api/mesh/endpoint", {
      meshEndpoint: advertisedEndpoint,
    });
    expect(restartedEndpoint.status).toBe(200);
    await waitForCondition(async () => {
      const status = await getStatus(nodeA);
      return getLink(status).members.find((member) => member.nodeId === nodeBId)?.endpoint === nodeB.baseUrl;
    }, "A peer restart replaced the direct pairing route.");
  });

  test("updates node-owned execution defaults through the signed Mesh boundary", async () => {
    for (const name of ["A", "B"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-defaults-${name.toLowerCase()}-`)));
    }
    meshNodes.push(await startMeshNode("A", meshDataDirs[0]!));
    meshNodes.push(await startMeshNode("B", meshDataDirs[1]!));
    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });
      expect(result.status).toBe(200);
    }
    await pairNodes(nodeA, nodeB);
    await waitForMemberConvergence(meshNodes, 2);

    const nodeBStatus = await getStatus(nodeB);
    const nodeBId = nodeBStatus.node.nodeId;
    const hostsResult = await request(nodeA, "/api/execution-hosts");
    expect(hostsResult.status).toBe(200);
    const host = (hostsResult.body as Array<{
      ref: { kind: string; nodeId?: string };
      configurationRevision: number;
    }>).find((candidate) =>
      candidate.ref.kind === "mesh" && candidate.ref.nodeId === nodeBId);
    expect(host).toBeDefined();

    const preferredModel = {
      providerID: "copilot",
      modelID: "auto",
      variant: "",
    };
    const update = await request(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/configuration`,
      {
        method: "PATCH",
        body: JSON.stringify({
          repositoriesBasePath: nodeB.dataDir,
          preferredModel,
          expectedRevision: host!.configurationRevision,
        }),
      },
    );
    if (update.status !== 200) {
      throw new Error(
        `Mesh configuration update failed: ${JSON.stringify(update.body)}\n`
        + `Controller logs: ${nodeA.output.read()}\nTarget logs: ${nodeB.output.read()}`,
      );
    }
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({
      repositoriesBasePath: nodeB.dataDir,
      preferredModel,
      configurationRevision: host!.configurationRevision + 1,
    });

    await waitForCondition(async () => {
      const [targetStatus, controllerHosts] = await Promise.all([
        getStatus(nodeB),
        request(nodeA, "/api/execution-hosts"),
      ]);
      const controllerHost = (controllerHosts.body as Array<{
        ref: { kind: string; nodeId?: string };
        repositoriesBasePath: string | null;
        preferredModel: unknown;
      }>).find((candidate) =>
        candidate.ref.kind === "mesh" && candidate.ref.nodeId === nodeBId);
      return targetStatus.node.execution?.repositoriesBasePath === nodeB.dataDir
        && targetStatus.node.execution.preferredModel?.modelID === "auto"
        && targetStatus.node.execution.acceptRemoteExecution
        && controllerHost?.repositoriesBasePath === nodeB.dataDir
        && JSON.stringify(controllerHost.preferredModel) === JSON.stringify(preferredModel);
    }, "The node-owned execution defaults did not converge.");

    const staleUpdate = await request(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/configuration`,
      {
        method: "PATCH",
        body: JSON.stringify({
          repositoriesBasePath: nodeB.dataDir,
          preferredModel: null,
          expectedRevision: host!.configurationRevision,
        }),
      },
    );
    expect(staleUpdate.status).toBe(409);
  });

  test("discovers and starts a direct chat on a Mesh execution host", async () => {
    for (const name of ["A", "B"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-chat-${name.toLowerCase()}-`)));
    }
    meshNodes.push(await startMeshNode("A", meshDataDirs[0]!, undefined, { mockAcp: true }));
    meshNodes.push(await startMeshNode("B", meshDataDirs[1]!, undefined, { mockAcp: true }));
    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });
      expect(result.status).toBe(200);
    }
    await pairNodes(nodeA, nodeB);
    await waitForMemberConvergence(meshNodes, 2);

    const nodeBId = (await getStatus(nodeB)).node.nodeId;
    const workingDirectory = await request(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/working-directory`,
    );
    if (workingDirectory.status !== 200) {
      throw new Error(
        `Mesh working-directory resolution failed: ${JSON.stringify(workingDirectory.body)}\n`
        + `Controller logs: ${nodeA.output.read()}\nTarget logs: ${nodeB.output.read()}`,
      );
    }
    expect(workingDirectory.status).toBe(200);
    expect(workingDirectory.body).toEqual({
      directory: process.cwd(),
      configured: false,
    });

    const providers = await postJson(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/chat-providers`,
      { credentialToken: null },
    );
    expect(providers.status).toBe(200);
    expect((providers.body as {
      providers: Array<{ providerID: string; available: boolean }>;
    }).providers).toContainEqual({
      providerID: "copilot",
      available: true,
    });

    const models = await postJson(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/chat-models`,
      {
        credentialToken: null,
        providerID: "copilot",
        directory: process.cwd(),
      },
    );
    expect(models.status).toBe(200);
    const selectedModel = (models.body as Array<{
      providerID: string;
      modelID: string;
      variants?: string[];
      connected: boolean;
    }>).find((model) => model.connected);
    expect(selectedModel).toBeDefined();

    const created = await postJson(
      nodeA,
      `/api/execution-hosts/mesh/${encodeURIComponent(nodeBId)}/chats`,
      {
        name: "Mesh direct chat",
        directory: process.cwd(),
        model: {
          providerID: selectedModel!.providerID,
          modelID: selectedModel!.modelID,
          variant: selectedModel!.variants?.[0] ?? "",
        },
        autoApprovePermissions: true,
        credentialToken: null,
      },
    );
    expect(created.status).toBe(201);
    const chatId = (created.body as {
      config: { id: string; source: { kind: string; directory: string } };
    }).config.id;
    expect(created.body).toMatchObject({
      config: {
        source: {
          kind: "execution_host",
          directory: process.cwd(),
        },
      },
    });

    const reconnected = await postJson(
      nodeA,
      `/api/chats/${encodeURIComponent(chatId)}/reconnect`,
      { credentialToken: null },
    );
    expect(reconnected.status).toBe(200);
    expect(reconnected.body).toMatchObject({
      state: { connectionStatus: "connected" },
    });
  });

  test("keeps a remote-stdio workspace local while executing through its selected peer", async () => {
    for (const name of ["A", "B"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-execution-${name.toLowerCase()}-`)));
    }
    const repository = await mkdtemp(join(tmpdir(), "clanky-mesh-execution-repo-"));
    meshRepositories.push(repository);
    await initializeGitRepository(repository, {
      initialCommit: "readme",
      initialFiles: { "README.md": "mesh execution\n" },
      initialCommitMessage: "initial",
    });

    meshNodes.push(await startMeshNode("A", meshDataDirs[0]!));
    meshNodes.push(await startMeshNode("B", meshDataDirs[1]!));
    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });
      expect(result.status).toBe(200);
    }

    await pairNodes(nodeA, nodeB);
    await waitForMemberConvergence(meshNodes, 2);

    const nodeBId = (await getStatus(nodeB)).node.nodeId;
    const workspaceResult = await postJson(nodeA, "/api/workspaces", {
      name: "Remote execution workspace",
      directory: repository,
      serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      executionNodeId: nodeBId,
    });
    expect(workspaceResult.status).toBe(201);
    const workspace = workspaceResult.body as {
      id: string;
      executionNodeId: string | null;
    };
    expect(workspace.executionNodeId).toBe(nodeBId);

    const remoteWorkspaces = await request(nodeB, "/api/workspaces");
    expect(remoteWorkspaces.status).toBe(200);
    expect(remoteWorkspaces.body).toEqual([]);

    const nodeAId = (await getStatus(nodeA)).node.nodeId;
    const localEdit = await request(nodeA, `/api/workspaces/${workspace.id}`, {
      method: "PUT",
      body: JSON.stringify({
        executionNodeId: nodeAId,
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      }),
    });
    expect(localEdit.status).toBe(200);
    expect(localEdit.body).toMatchObject({ executionNodeId: nodeAId });

    const remoteEdit = await request(nodeA, `/api/workspaces/${workspace.id}`, {
      method: "PUT",
      body: JSON.stringify({
        executionNodeId: nodeBId,
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      }),
    });
    expect(remoteEdit.status).toBe(200);
    expect(remoteEdit.body).toMatchObject({ executionNodeId: nodeBId });

    const remoteStatus = await request(
      nodeA,
      `/api/workspaces/${workspace.id}/server-settings/status`,
    );
    expect(remoteStatus.status).toBe(200);
    expect(remoteStatus.body).toMatchObject({
      executionAvailability: "remote-connected",
      directoryExists: true,
      isGitRepo: true,
    });

    const remoteRead = await request(
      nodeA,
      `/api/workspaces/${workspace.id}/files/content?path=README.md`,
    );
    expect(remoteRead.status).toBe(200);
    expect(remoteRead.body).toMatchObject({
      workspaceId: workspace.id,
      content: "mesh execution\n",
    });

    const remoteWrite = await postJson(
      nodeA,
      `/api/workspaces/${workspace.id}/files/write`,
      {
        path: "remote.txt",
        content: "written through owner\n",
        expectedVersionToken: null,
        overwrite: true,
        startDirectory: null,
      },
    );
    expect(remoteWrite.status).toBe(200);
    expect(await Bun.file(join(repository, "remote.txt")).text()).toBe("written through owner\n");

    const uploadBytes = Uint8Array.from(
      { length: 8 * 1024 * 1024 + 3 },
      (_, index) => index % 251,
    );
    const uploadCreate = await postJson(
      nodeA,
      `/api/workspaces/${workspace.id}/files/upload`,
      {
        directory: ".",
        fileName: "mesh-upload.bin",
        size: uploadBytes.byteLength,
        overwrite: false,
      },
    );
    expect(uploadCreate.status).toBe(201);
    const uploadId = (uploadCreate.body as { uploadId: string }).uploadId;
    const uploadChunk = await fetch(
      `${nodeA.baseUrl}/api/workspaces/${workspace.id}/files/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&offset=0`,
      {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          origin: nodeA.baseUrl,
        },
        body: new Blob([uploadBytes]),
      },
    );
    expect(uploadChunk.status).toBe(200);
    expect(await uploadChunk.json()).toMatchObject({
      success: true,
      nextOffset: uploadBytes.byteLength,
    });
    const uploadComplete = await postJson(
      nodeA,
      `/api/workspaces/${workspace.id}/files/upload/complete`,
      { uploadId },
    );
    expect(uploadComplete.status).toBe(200);
    expect(await Bun.file(join(repository, "mesh-upload.bin")).size).toBe(uploadBytes.byteLength);
    expect(new Uint8Array(await Bun.file(join(repository, "mesh-upload.bin")).arrayBuffer()))
      .toEqual(uploadBytes);

    await stopMeshNode(nodeB);
    await waitForCondition(
      async () => {
        const status = await request(
          nodeA,
          `/api/workspaces/${workspace.id}/server-settings/status`,
        );
        return status.status === 200
          && (status.body as { executionAvailability?: string }).executionAvailability === "remote-unavailable";
      },
      "The workspace instance did not observe the execution peer outage.",
      15_000,
    );

    const unavailableRead = await request(
      nodeA,
      `/api/workspaces/${workspace.id}/files/content?path=README.md`,
    );
    expect(unavailableRead.status).toBe(500);
    expect(unavailableRead.body).toMatchObject({ error: "workspace_file_error" });

    meshNodes[1] = await startMeshNode("B-restarted", nodeB.dataDir, nodeB.port);
    await waitForCondition(
      async () => {
        const status = await request(
          nodeA,
          `/api/workspaces/${workspace.id}/server-settings/status`,
        );
        return status.status === 200
          && (status.body as { executionAvailability?: string }).executionAvailability === "remote-connected";
      },
      "The workspace instance did not recover remote execution after the peer restart.",
      15_000,
    );

    const recoveredRead = await request(
      nodeA,
      `/api/workspaces/${workspace.id}/files/content?path=README.md`,
    );
    expect(recoveredRead.status).toBe(200);
  }, { timeout: 30_000 });

  test("discovers remote-stdio models from a remote-only owner", async () => {
    for (const name of ["A", "B"]) {
      meshDataDirs.push(await mkdtemp(join(tmpdir(), `clanky-mesh-models-${name.toLowerCase()}-`)));
    }
    const repository = await mkdtemp(join(tmpdir(), "clanky-mesh-models-repo-"));
    meshRepositories.push(repository);
    await initializeGitRepository(repository, {
      initialCommit: "readme",
      initialFiles: { "README.md": "mesh models\n" },
      initialCommitMessage: "initial",
    });

    meshNodes.push(await startMeshNode("A", meshDataDirs[0]!, undefined, { remoteOnly: true }));
    meshNodes.push(await startMeshNode("B", meshDataDirs[1]!, undefined, { mockAcp: true }));
    const nodeA = meshNodes[0]!;
    const nodeB = meshNodes[1]!;

    for (const node of meshNodes) {
      const result = await postJson(node, "/api/mesh/instance-name", {
        instanceName: `Instance ${node.name}`,
      });
      expect(result.status).toBe(200);
    }

    await pairNodes(nodeA, nodeB);
    await waitForCondition(async () => {
      const status = await getStatus(nodeA);
      return status.links[0]?.members.length === 2
        && status.links[0].members.every((member) => member.endpoint !== null);
    }, "The model discovery mesh did not converge.");

    const nodeBId = (await getStatus(nodeB)).node.nodeId;
    const workspaceResult = await postJson(nodeA, "/api/workspaces", {
      name: "Remote model workspace",
      directory: repository,
      serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      executionNodeId: nodeBId,
    });
    expect(workspaceResult.status).toBe(201);
    const workspace = workspaceResult.body as { id: string };

    const models = await request(nodeA, `/api/models?workspaceId=${workspace.id}`);
    expect(models.status).toBe(200);
    expect(models.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connected: true,
        modelID: "mock-model",
        providerID: "opencode",
      }),
    ]));

    const variants = await request(
      nodeA,
      `/api/models/variants?workspaceId=${workspace.id}&modelID=mock-model`,
    );
    expect(variants.status).toBe(200);
    expect(variants.body).toEqual({ variants: ["medium", "low", "high"] });
  }, { timeout: 30_000 });
});
