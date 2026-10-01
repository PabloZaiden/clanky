import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshCommandExecutorClient } from "../../src/core/mesh-command-executor-client";
import { encryptMeshPayload } from "../../src/core/mesh-payload-crypto";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { POSIX_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import {
  MESH_ACP_SESSION_RENEWAL_LEAD_MS,
  MESH_ACP_SESSION_RENEWAL_RETRY_MS,
  MESH_ACP_SESSION_RENEWAL_SAFETY_MARGIN_MS,
  MESH_ACP_SESSION_TTL_MS,
  MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS,
} from "../../src/shared/mesh-execution";
import { MESH_PROTOCOL_VERSION } from "../../src/shared/mesh-protocol";
import { seedTestOwnerUser } from "../setup";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-mesh-client-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  seedTestOwnerUser();
});

afterEach(async () => {
  jest.useRealTimers();
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("MeshCommandExecutorClient", () => {
  test("encrypts the managed environment in session requests", async () => {
    await ensureLocalMeshNodeIdentity();
    const workerEncryption = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    const workerEncryptionPublicKey = workerEncryption.publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let releaseFirstRequest!: () => void;
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    let requestStarted!: () => void;
    const firstRequestStarted = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let sessionRequestCount = 0;
    let sessionRequest: Record<string, unknown> | undefined;
    const fetchImpl = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        sessionRequestCount += 1;
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sessionRequest = request;
        if (sessionRequestCount === 1) {
          requestStarted();
          await firstRequestReleased;
        }
        if (init?.signal?.aborted) {
          throw new DOMException("The request was aborted.", "AbortError");
        }
        const expiresAt = request["expiresAt"];
        return Response.json({
          protocolVersion: MESH_PROTOCOL_VERSION,
          sessionId: "session-1",
          expiresAt,
          encryptedPayload: encryptMeshPayload(
            {
              sessionToken: "s".repeat(32),
              executionRoot: "/absolute/workspace",
            },
            request["callerEncryptionPublicKey"] as string,
          ),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      managedEnvironment: {
        CLANKY_BASE_URL: "https://clanky.example",
        CLANKY_API_KEY: "wapp_test_secret",
      },
      fetch: fetchImpl,
    });

    const firstOpen = client.openSession();
    await firstRequestStarted;
    const secondOpen = client.openSession();
    releaseFirstRequest();
    await Promise.all([firstOpen, secondOpen]);

    expect(sessionRequestCount).toBe(1);
    expect(await client.getExecutionDirectory()).toBe("/absolute/workspace");
    expect(sessionRequest?.["encryptedEnvironment"]).toMatchObject({
      __clankyMeshEncrypted: true,
    });
    expect(JSON.stringify(sessionRequest?.["encryptedEnvironment"])).not.toContain("wapp_test_secret");
    expect(client.getSessionConnection().sessionId).toBe("session-1");
    client.closeSession();
  });

  test("renews an ACP session before its lease expires", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let renewalRequests = 0;
    let resolveRenewal!: () => void;
    const renewalStarted = new Promise<void>((resolve) => {
      resolveRenewal = resolve;
    });
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown> | null;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request?.["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request?.["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (url.endsWith("/acp/renew")) {
          renewalRequests += 1;
          resolveRenewal();
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: new Date(Date.now() + MESH_ACP_SESSION_TTL_MS).toISOString(),
          });
        }
        throw new Error(`Unexpected mesh route: ${url}`);
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      sessionTtlMs: MESH_ACP_SESSION_RENEWAL_LEAD_MS + 100,
      fetch: fetchImpl,
    });

    try {
      await client.openSession();
      client.startSessionRenewal();
      await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("Timed out waiting for ACP session renewal"));
        }, 2_000);
        renewalStarted.then(() => {
          clearTimeout(timeoutId);
          resolve();
        });
      });
      expect(renewalRequests).toBe(1);
    } finally {
      client.closeSession();
    }
  });

  test("releases a remote session when opening is cancelled after worker creation", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let requestStarted!: () => void;
    const responseStarted = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let releaseRequests = 0;
    const fetchImpl = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (init?.method === "DELETE") {
          releaseRequests += 1;
          expect(body["sessionId"]).toBe("session-1");
          expect(body["sessionToken"]).toBe("s".repeat(32));
          return Response.json({ success: true });
        }
        requestStarted();
        await responseGate;
        return Response.json({
          protocolVersion: MESH_PROTOCOL_VERSION,
          sessionId: "session-1",
          expiresAt: new Date(Date.now() + MESH_ACP_SESSION_TTL_MS).toISOString(),
          encryptedPayload: encryptMeshPayload(
            { sessionToken: "s".repeat(32) },
            body["callerEncryptionPublicKey"] as string,
          ),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    const opening = client.openSession(controller.signal);
    await responseStarted;
    controller.abort();
    releaseResponse();

    await expect(opening).rejects.toMatchObject({ code: "mesh_execution_aborted" });
    expect(releaseRequests).toBe(1);
    client.closeSession();
  });

  test("retries a transient renewal failure using bounded backoff", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    jest.useFakeTimers();
    let callerEncryptionPublicKey = "";
    let renewalRequests = 0;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown> | null;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request?.["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request?.["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (url.endsWith("/acp/renew")) {
          renewalRequests += 1;
          if (renewalRequests === 1) {
            throw new Error("temporary worker network failure");
          }
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: new Date(Date.now() + MESH_ACP_SESSION_TTL_MS).toISOString(),
          });
        }
        throw new Error(`Unexpected mesh route: ${url}`);
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      sessionTtlMs: MESH_ACP_SESSION_RENEWAL_LEAD_MS + 100,
      fetch: fetchImpl,
    });

    try {
      await client.openSession();
      client.startSessionRenewal();
      jest.advanceTimersToNextTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(renewalRequests).toBe(1);

      jest.advanceTimersByTime(MESH_ACP_SESSION_RENEWAL_RETRY_MS - 1);
      await Promise.resolve();
      expect(renewalRequests).toBe(1);

      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(renewalRequests).toBe(2);
    } finally {
      client.closeSession();
    }
  });

  test("stops retrying when the renewal safety window is reached", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    jest.useFakeTimers();
    let callerEncryptionPublicKey = "";
    let renewalRequests = 0;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown> | null;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request?.["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request?.["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (url.endsWith("/acp/renew")) {
          renewalRequests += 1;
          throw new Error("temporary worker network failure");
        }
        throw new Error(`Unexpected mesh route: ${url}`);
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      sessionTtlMs: MESH_ACP_SESSION_RENEWAL_SAFETY_MARGIN_MS + 1,
      fetch: fetchImpl,
    });

    try {
      await client.openSession();
      client.startSessionRenewal();
      jest.advanceTimersToNextTimer();
      await Promise.resolve();
      await Promise.resolve();
      expect(renewalRequests).toBe(1);

      jest.advanceTimersByTime(MESH_ACP_SESSION_RENEWAL_RETRY_MS * 2);
      await Promise.resolve();
      expect(renewalRequests).toBe(1);
    } finally {
      client.closeSession();
    }
  });

  test("cancels an in-flight renewal when the session closes", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    jest.useFakeTimers();
    let callerEncryptionPublicKey = "";
    let renewalRequests = 0;
    let renewalStarted!: () => void;
    let renewalAborted = false;
    const renewalStartedPromise = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown> | null;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request?.["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request?.["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (url.endsWith("/acp/renew")) {
          renewalRequests += 1;
          renewalStarted();
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              renewalAborted = true;
              reject(new DOMException("The renewal request was aborted.", "AbortError"));
            }, { once: true });
          });
        }
        throw new Error(`Unexpected mesh route: ${url}`);
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      channel: "acp",
      sessionTtlMs: MESH_ACP_SESSION_RENEWAL_LEAD_MS + 100,
      fetch: fetchImpl,
    });

    try {
      await client.openSession();
      client.startSessionRenewal();
      jest.advanceTimersToNextTimer();
      await renewalStartedPromise;
      expect(renewalRequests).toBe(1);

      client.closeSession();
      await Promise.resolve();
      expect(renewalAborted).toBe(true);

      jest.advanceTimersByTime(MESH_ACP_SESSION_RENEWAL_RETRY_MS * 2);
      await Promise.resolve();
      expect(renewalRequests).toBe(1);
    } finally {
      client.closeSession();
    }
  });

  test("retries a lost async start response without launching a second command", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let startAttempts = 0;
    let firstStartRequestId: string | undefined;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (!url.endsWith("/execution/async") || request["action"] !== "start") {
          throw new Error(`Unexpected mesh route: ${url}`);
        }

        startAttempts += 1;
        if (startAttempts === 1) {
          firstStartRequestId = request["requestId"] as string;
          throw new Error("connection closed after the worker accepted the command");
        }
        expect(request["requestId"]).toBe(firstStartRequestId);
        return Response.json({
          protocolVersion: MESH_PROTOCOL_VERSION,
          requestId: request["requestId"],
          encryptedPayload: encryptMeshPayload({
            jobId: "command-1",
            status: "completed",
            result: {
              success: true,
              stdout: "recovered\n",
              stderr: "",
              exitCode: 0,
            },
          }, callerEncryptionPublicKey),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      fetch: fetchImpl,
    });

    await expect(client.exec("devbox", ["rebuild"], { longRunning: true })).resolves.toEqual({
      success: true,
      stdout: "recovered\n",
      stderr: "",
      exitCode: 0,
    });
    expect(startAttempts).toBe(2);
    client.closeSession();
  });

  test("cancels the remote command when the provisioning signal is aborted", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let cancelJobId: string | undefined;
    const abortController = new AbortController();
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (!url.endsWith("/execution/async")) {
          throw new Error(`Unexpected mesh route: ${url}`);
        }
        if (request["action"] === "start") {
          abortController.abort();
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            requestId: request["requestId"],
            encryptedPayload: encryptMeshPayload({
              jobId: "command-1",
              status: "running",
            }, callerEncryptionPublicKey),
          });
        }
        expect(request["action"]).toBe("cancel");
        cancelJobId = request["jobId"] as string;
        return Response.json({
          protocolVersion: MESH_PROTOCOL_VERSION,
          requestId: request["requestId"],
          encryptedPayload: encryptMeshPayload({
            jobId: "command-1",
            status: "cancelled",
            error: {
              code: "mesh_execution_aborted",
              message: "cancelled",
            },
          }, callerEncryptionPublicKey),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      fetch: fetchImpl,
    });

    await expect(client.exec("devbox", ["rebuild"], {
      longRunning: true,
      signal: abortController.signal,
    })).rejects.toMatchObject({ code: "mesh_execution_aborted" });
    expect(cancelJobId).toBe("command-1");
    client.closeSession();
  });

  test("queues execution RPCs within the worker limit and removes aborted waiters", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    let workerLimitRejections = 0;
    let rpcRequestCount = 0;
    const rpcPaths: string[] = [];
    let holdRequests = false;
    let requestBarrier = Promise.resolve();
    let releaseRequestBarrier = (): void => {};
    let signalWaveStarted: (() => void) | undefined;
    const waitForFullWave = (): Promise<void> => new Promise((resolve) => {
      signalWaveStarted = resolve;
    });
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/session")) {
          if (init?.method === "DELETE") {
            return Response.json({ success: true });
          }
          callerEncryptionPublicKey = request["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (!url.endsWith("/execution/rpc")) {
          throw new Error(`Unexpected mesh route: ${url}`);
        }

        rpcRequestCount += 1;
        rpcPaths.push(request["path"] as string);
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        if (activeRequests > MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS) {
          activeRequests -= 1;
          workerLimitRejections += 1;
          return Response.json({
            error: "mesh_execution_limit_exceeded",
            message: "The execution session has too many in-flight requests.",
          }, { status: 503 });
        }
        if (activeRequests === MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS) {
          signalWaveStarted?.();
          signalWaveStarted = undefined;
        }
        if (holdRequests) await requestBarrier;
        activeRequests -= 1;
        if (request["path"] === "/workspace/failure") {
          return Response.json({
            error: "mesh_execution_request_failed",
            message: "The test execution request failed.",
          }, { status: 500 });
        }
        return Response.json({
          protocolVersion: MESH_PROTOCOL_VERSION,
          requestId: request["requestId"],
          encryptedPayload: encryptMeshPayload(null, callerEncryptionPublicKey),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      fetch: fetchImpl,
    });

    try {
      holdRequests = true;
      requestBarrier = new Promise<void>((resolve) => {
        releaseRequestBarrier = resolve;
      });
      const firstWaveStarted = waitForFullWave();
      const firstBatch = Array.from({ length: 10 }, (_, index) => (
        client.getFileMetadata(
          index === 0 ? "/workspace/failure" : `/workspace/${String(index)}`,
          { includeContentHash: false },
        )
      ));
      await firstWaveStarted;
      expect(activeRequests).toBe(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(rpcRequestCount).toBe(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);

      holdRequests = false;
      releaseRequestBarrier();
      const firstResults = await Promise.allSettled(firstBatch);
      expect(firstResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(firstResults.filter((result) => result.status === "fulfilled")).toHaveLength(9);
      expect(rpcRequestCount).toBe(10);
      expect(rpcPaths).toEqual([
        "/workspace/failure",
        ...Array.from({ length: 9 }, (_, index) => `/workspace/${String(index + 1)}`),
      ]);
      expect(maximumActiveRequests).toBe(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(workerLimitRejections).toBe(0);

      holdRequests = true;
      requestBarrier = new Promise<void>((resolve) => {
        releaseRequestBarrier = resolve;
      });
      const secondWaveStarted = waitForFullWave();
      const secondBatch = Array.from({ length: MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS }, (_, index) => (
        client.getFileMetadata(`/workspace/held-${String(index)}`, { includeContentHash: false })
      ));
      await secondWaveStarted;

      const abortController = new AbortController();
      const cancelled = client.getFileMetadata("/workspace/cancelled", {
        includeContentHash: false,
        signal: abortController.signal,
      });
      abortController.abort();
      await expect(cancelled).rejects.toMatchObject({ code: "mesh_execution_aborted" });
      expect(rpcRequestCount).toBe(10 + MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(rpcPaths).not.toContain("/workspace/cancelled");

      holdRequests = false;
      releaseRequestBarrier();
      await Promise.all(secondBatch);
      await expect(client.getFileMetadata("/workspace/after-queue", { includeContentHash: false }))
        .resolves.toBeNull();
      expect(rpcRequestCount).toBe(11 + MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(workerLimitRejections).toBe(0);

      const beforeCloseCount = rpcRequestCount;
      holdRequests = true;
      requestBarrier = new Promise<void>((resolve) => {
        releaseRequestBarrier = resolve;
      });
      const closeWaveStarted = waitForFullWave();
      const closeBatch = Array.from({ length: MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS }, (_, index) => (
        client.getFileMetadata(`/workspace/closing-${String(index)}`, { includeContentHash: false })
      ));
      await closeWaveStarted;
      const closedWaiter = client.getFileMetadata("/workspace/closed-queue", {
        includeContentHash: false,
      });
      const closedWaiterResult = closedWaiter.catch((error: unknown) => error);
      client.closeSession();
      expect(await closedWaiterResult).toMatchObject({ code: "mesh_execution_aborted" });
      expect(rpcRequestCount - beforeCloseCount).toBe(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(rpcPaths).not.toContain("/workspace/closed-queue");

      holdRequests = false;
      releaseRequestBarrier();
      await Promise.all(closeBatch);
      expect(activeRequests).toBe(0);
    } finally {
      holdRequests = false;
      releaseRequestBarrier();
      client.closeSession();
    }
  });

  test("holds Mesh slots until streamed downloads are cancelled", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: "test-encryption-key",
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let streamRequestCount = 0;
    let rpcRequestCount = 0;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/session")) {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          callerEncryptionPublicKey = request["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            sessionId: "session-1",
            expiresAt: request["expiresAt"],
            encryptedPayload: encryptMeshPayload(
              { sessionToken: "s".repeat(32) },
              callerEncryptionPublicKey,
            ),
          });
        }
        if (url.includes("/execution/file?") && init?.method === "GET") {
          streamRequestCount += 1;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          });
          return new Response(body, {
            headers: { "content-type": "application/octet-stream" },
          });
        }
        if (url.endsWith("/execution/rpc")) {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          rpcRequestCount += 1;
          return Response.json({
            protocolVersion: MESH_PROTOCOL_VERSION,
            requestId: request["requestId"],
            encryptedPayload: encryptMeshPayload(null, callerEncryptionPublicKey),
          });
        }
        throw new Error(`Unexpected mesh route: ${url}`);
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      fetch: fetchImpl,
    });
    let streams: ReadableStream<Uint8Array>[] = [];

    try {
      const openedStreams = await Promise.all(Array.from(
        { length: MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS },
        async (_, index) => await client.streamFile(`/workspace/stream-${String(index)}`),
      ));
      streams = openedStreams.filter(
        (stream): stream is ReadableStream<Uint8Array> => stream !== null,
      );
      expect(streams).toHaveLength(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);
      expect(streamRequestCount).toBe(MESH_EXECUTION_MAX_IN_FLIGHT_REQUESTS);

      const queued = client.getFileMetadata("/workspace/after-stream", {
        includeContentHash: false,
      });
      expect(rpcRequestCount).toBe(0);
      await streams[0]!.cancel();
      await expect(queued).resolves.toBeNull();
      expect(rpcRequestCount).toBe(1);

      await Promise.all(streams.slice(1).map(async (stream) => await stream.cancel()));
    } finally {
      await Promise.allSettled(streams.map(async (stream) => await stream.cancel()));
      client.closeSession();
    }
  });
});
