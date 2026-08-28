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
      CLANKY_LOG_LEVEL: "fatal",
      CLANKY_PORT: String(port),
      CLANKY_PUBLIC_BASE_URL: baseUrl,
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

async function waitForThreeMemberConvergence(nodes: MeshNodeProcess[]): Promise<MeshStatus[]> {
  let statuses: MeshStatus[] = [];
  await waitForCondition(async () => {
    statuses = await Promise.all(nodes.map((node) => getStatus(node)));
    return statuses.every((status) => {
      const link = status.links[0];
      return link?.members.length === 3
        && link.members.every((member) => member.endpoint !== null)
        && new Set(link.members.map((member) => member.endpoint)).size === 3;
    });
  }, "The three mesh nodes did not converge.");
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

    const converged = await waitForThreeMemberConvergence(meshNodes);
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
    await waitForCondition(async () => {
      const status = await getStatus(nodeB);
      return status.links[0]?.members.length === 2
        && status.links[0].members.every((member) => member.endpoint !== null);
    }, "The execution mesh did not converge.");

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
});
