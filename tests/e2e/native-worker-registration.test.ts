import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

interface FileWriteResponse {
  success: true;
  file: {
    path: string;
    versionToken: string;
  };
}

interface FileListResponse {
  directory: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
  }>;
}

interface FileReadResponse {
  content: string;
  file: {
    path: string;
  };
}

interface FileMutationResponse {
  success: true;
  file?: {
    path: string;
    versionToken: string;
  };
  deletedPath?: string;
}

interface FileUploadResponse {
  uploadId: string;
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

    const filesPath = `/api/execution-hosts/mesh/${encodeURIComponent(
      registration.workerNodeId,
    )}/files`;
    const createdFile = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          content: "created on native worker\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(createdFile.status).toBe(200);
    expect(createdFile.body.file.path).toBe("native-files/worker.txt");

    const listedFiles = await meshJsonRequest<FileListResponse>(
      controller,
      `${filesPath}?path=${encodeURIComponent("native-files")}`,
    );
    expect(listedFiles.status).toBe(200);
    expect(listedFiles.body).toMatchObject({
      directory: "native-files",
      entries: [{
        name: "worker.txt",
        path: "native-files/worker.txt",
        kind: "file",
      }],
    });

    const readFile = await meshJsonRequest<FileReadResponse>(
      controller,
      `${filesPath}/content?path=${encodeURIComponent("native-files/worker.txt")}`,
    );
    expect(readFile.status).toBe(200);
    expect(readFile.body).toMatchObject({
      content: "created on native worker\n",
      file: { path: "native-files/worker.txt" },
    });

    const overwrittenFile = await meshJsonRequest<FileWriteResponse>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          content: "updated on native worker\n",
          expectedVersionToken: createdFile.body.file.versionToken,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(overwrittenFile.status).toBe(200);
    expect(await Bun.file(
      join(worker.dataDir, "native-files", "worker.txt"),
    ).text()).toBe("updated on native worker\n");

    const renamedFile = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/rename`,
      {
        method: "POST",
        body: {
          path: "native-files/worker.txt",
          newName: "renamed.txt",
          expectedVersionToken: overwrittenFile.body.file.versionToken,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(renamedFile.status).toBe(200);
    expect(renamedFile.body.file?.path).toBe("native-files/renamed.txt");

    const downloadResponse = await meshJsonRequest<string>(
      controller,
      `${filesPath}/download?path=${
        encodeURIComponent("native-files/renamed.txt")
      }`,
      {
        responseType: "text",
      },
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.body).toBe("updated on native worker\n");

    const uploadedContent = "streamed to native worker\n";
    const upload = await meshJsonRequest<FileUploadResponse>(
      controller,
      `${filesPath}/upload`,
      {
        method: "POST",
        body: {
          directory: "native-files",
          fileName: "renamed.txt",
          size: new TextEncoder().encode(uploadedContent).byteLength,
          overwrite: true,
          startDirectory: null,
        },
      },
    );
    expect(upload.status).toBe(201);

    const uploadChunkResponse = await meshJsonRequest<{ success: boolean }>(
      controller,
      `${filesPath}/upload/chunk?uploadId=${
        encodeURIComponent(upload.body.uploadId)
      }&offset=0`,
      {
        method: "POST",
        rawBody: uploadedContent,
      },
    );
    expect(uploadChunkResponse.status).toBe(200);

    const completedUpload = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/upload/complete`,
      {
        method: "POST",
        body: {
          uploadId: upload.body.uploadId,
          startDirectory: null,
        },
      },
    );
    expect(completedUpload.status).toBe(200);
    expect(completedUpload.body.file?.path).toBe("native-files/renamed.txt");

    const uploadedFile = await meshJsonRequest<FileReadResponse>(
      controller,
      `${filesPath}/content?path=${
        encodeURIComponent("native-files/renamed.txt")
      }`,
    );
    expect(uploadedFile.status).toBe(200);
    expect(uploadedFile.body.content).toBe(uploadedContent);

    const deletedDirectory = await meshJsonRequest<FileMutationResponse>(
      controller,
      `${filesPath}/delete`,
      {
        method: "POST",
        body: {
          path: "native-files",
          kind: "directory",
          startDirectory: null,
        },
      },
    );
    expect(deletedDirectory.status).toBe(200);
    expect(deletedDirectory.body.deletedPath).toBe("native-files");
    expect(await Bun.file(
      join(worker.dataDir, "native-files", "renamed.txt"),
    ).exists()).toBe(false);

    const escapedWrite = await meshJsonRequest<{ error: string }>(
      controller,
      `${filesPath}/write`,
      {
        method: "POST",
        body: {
          path: "../native-worker-escape.txt",
          content: "must not escape\n",
          expectedVersionToken: null,
          overwrite: false,
          startDirectory: null,
        },
      },
    );
    expect(escapedWrite.status).toBe(400);
    expect(escapedWrite.body.error).toBe("invalid_server_path");

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
