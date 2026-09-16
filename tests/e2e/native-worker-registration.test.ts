import { afterEach, describe, expect, test } from "bun:test";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  restartMeshNode,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
  type MeshJsonResponse,
} from "../helpers/mesh-process-cluster";
import { pollUntil } from "../helpers/polling";
import {
  createExecutionHostRuntimeSnapshot,
  type ExecutionHostRuntimeSnapshot,
} from "../../src/shared/execution-host";
import type {
  MeshControllerStatus,
  MeshWorkerRegistration,
  MeshWorkerStatus,
} from "../../src/shared/mesh";

interface MeshHealthResponse {
  success: boolean;
  status: MeshControllerStatus;
}

let nodes: ManagedMeshNode[] = [];

function expectRuntimeSnapshot(
  registration: MeshWorkerRegistration,
  expected: ExecutionHostRuntimeSnapshot,
): void {
  expect(registration.workerPlatform).toEqual(expected.platform);
  expect(registration.workerCapabilities).toEqual(expected.capabilities);
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const node of nodes.reverse()) {
    try {
      await stopMeshNode(node);
    } catch (error) {
      failures.push(error);
    }
  }
  nodes = [];
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to clean up native Mesh E2E processes");
  }
});

describe("native worker registration", () => {
  test("enrolls, reports its runtime, passes health, and reconnects after restart", async () => {
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({ role: "controller", command });
    nodes.push(controller);
    const worker = await startMeshNode({ role: "worker", command });
    nodes.push(worker);

    await enrollMeshWorker(controller, worker);

    const expectedRuntime = createExecutionHostRuntimeSnapshot(
      process.platform,
      process.arch,
    );
    expect(expectedRuntime.platform).not.toBeNull();
    const expectedRunnerOs = process.env["CLANKY_NATIVE_E2E_EXPECTED_OS"];
    if (expectedRunnerOs) {
      const actualRunnerOs: string | undefined = expectedRuntime.platform?.os;
      expect(actualRunnerOs).toBe(expectedRunnerOs);
    }

    const registered = await pollUntil(
      async () => await meshJsonRequest<MeshControllerStatus>(
        controller,
        "/api/mesh/status",
      ),
      (response) => response.status === 200 && response.body.workers.length === 1,
      {
        description: "native worker registration",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const registration = registered.body.workers[0]!;
    expect(registration).toMatchObject({
      workerInstanceName: "worker-1",
      workerEndpoint: worker.baseUrl,
      workerTransport: "https",
      workerDirectory: worker.dataDir,
      workerAcceptRemoteExecution: true,
      grantStatus: "active",
      route: {
        kind: "direct",
        endpoint: worker.baseUrl,
        transport: "https",
        tlsTrust: "pinned",
      },
    });
    expectRuntimeSnapshot(registration, expectedRuntime);

    const workerStatus = await meshJsonRequest<MeshWorkerStatus>(
      worker,
      "/api/mesh/status",
    );
    expect(workerStatus.status).toBe(200);
    expect(workerStatus.body).toMatchObject({
      node: { nodeId: registration.workerNodeId },
      controllerCount: 1,
      execution: {
        directory: worker.dataDir,
        acceptRemoteExecution: true,
        ...expectedRuntime,
      },
    });

    const initialHealth = await pollUntil<
      MeshJsonResponse<MeshHealthResponse>
    >(
      async () => await meshJsonRequest<MeshHealthResponse>(
        controller,
        "/api/mesh/health",
        { method: "POST" },
      ),
      (response) => response.status === 200
        && response.body.success === true
        && typeof response.body.status.workers[0]?.lastSeenAt === "string",
      {
        description: "signed native worker health check",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const initialLastSeenAt = initialHealth.body.status.workers[0]!.lastSeenAt!;

    await restartMeshNode(worker, 20_000);
    expect(worker.generation).toBe(2);

    const reconnectedWorker = await pollUntil(
      async () => await meshJsonRequest<MeshWorkerStatus>(
        worker,
        "/api/mesh/status",
      ),
      (response) => response.status === 200
        && response.body.controllerCount === 1
        && response.body.node.nodeId === registration.workerNodeId,
      {
        description: "worker identity and controller grant after restart",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    expect(reconnectedWorker.body.execution).toMatchObject(expectedRuntime);

    const healthAfterRestart = await pollUntil(
      async () => await meshJsonRequest<MeshHealthResponse>(
        controller,
        "/api/mesh/health",
        { method: "POST" },
      ),
      (response) => response.status === 200
        && response.body.success === true
        && response.body.status.workers[0]?.workerNodeId
          === registration.workerNodeId
        && response.body.status.workers[0]?.lastSeenAt !== null
        && response.body.status.workers[0]?.lastSeenAt !== initialLastSeenAt,
      {
        description: "controller health check after native worker restart",
        timeoutMs: 20_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const registrationAfterRestart = healthAfterRestart.body.status.workers[0]!;
    expect(registrationAfterRestart.createdAt).toBe(registration.createdAt);
    expectRuntimeSnapshot(registrationAfterRestart, expectedRuntime);
  }, 120_000);
});
