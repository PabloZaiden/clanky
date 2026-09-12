import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshCommandExecutorClient } from "../../src/core/mesh-command-executor-client";
import { encryptMeshPayload } from "../../src/core/mesh-payload-crypto";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import { ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { saveWorkerRegistration } from "../../src/persistence/mesh";
import { DEFAULT_EXECUTION_HOST_CAPABILITIES } from "../../src/shared/execution-host";
import {
  MESH_ACP_SESSION_RENEWAL_LEAD_MS,
  MESH_ACP_SESSION_TTL_MS,
} from "../../src/shared/mesh-execution";
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
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("MeshCommandExecutorClient", () => {
  test("shares concurrent session opening and encrypts managed environment", async () => {
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
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
          protocolVersion: 1,
          sessionId: "session-1",
          expiresAt,
          encryptedPayload: encryptMeshPayload(
            { sessionToken: "s".repeat(32) },
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
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
            protocolVersion: 1,
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
            protocolVersion: 1,
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

  test("runs long-running commands through the asynchronous mesh protocol", async () => {
    await ensureLocalMeshNodeIdentity();
    await saveWorkerRegistration({
      workerNodeId: "worker-1",
      localUserId: "admin",
      workerInstanceName: "Worker",
      workerEndpoint: "http://worker.example",
      workerTransport: "http",
      workerPublicKey: "worker-public-key",
      workerFingerprint: "worker-fingerprint",
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
      workerAcceptRemoteExecution: true,
      workerConfigRevision: 1,
    });

    let callerEncryptionPublicKey = "";
    let statusRequests = 0;
    const fetchImpl = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url.endsWith("/session")) {
          callerEncryptionPublicKey = request["callerEncryptionPublicKey"] as string;
          return Response.json({
            protocolVersion: 1,
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

        let payload: Record<string, unknown>;
        if (request["action"] === "start") {
          payload = {
            jobId: "command-1",
            status: "running",
            output: {
              stdout: "",
              stderr: "",
              stdoutOffset: 0,
              stderrOffset: 0,
              nextStdoutOffset: 0,
              nextStderrOffset: 0,
            },
          };
        } else {
          statusRequests += 1;
          payload = statusRequests === 1
            ? {
                jobId: "command-1",
                status: "running",
                output: {
                  stdout: "devbox ",
                  stderr: "",
                  stdoutOffset: 0,
                  stderrOffset: 0,
                  nextStdoutOffset: 7,
                  nextStderrOffset: 0,
                },
              }
            : {
                jobId: "command-1",
                status: "completed",
                output: {
                  stdout: "rebuilt\n",
                  stderr: "",
                  stdoutOffset: 7,
                  stderrOffset: 0,
                  nextStdoutOffset: 15,
                  nextStderrOffset: 0,
                },
                result: {
                  success: true,
                  stdout: "devbox rebuilt\n",
                  stderr: "",
                  exitCode: 0,
                },
              };
        }
        return Response.json({
          protocolVersion: 1,
          requestId: request["requestId"],
          encryptedPayload: encryptMeshPayload(payload, callerEncryptionPublicKey),
        });
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch;

    const output: string[] = [];
    const client = new MeshCommandExecutorClient({
      workspaceId: "workspace-1",
      directory: "/workspace",
      executionNodeId: "worker-1",
      provider: "copilot",
      localUserId: "admin",
      fetch: fetchImpl,
    });

    const result = await client.exec("devbox", ["rebuild"], {
      longRunning: true,
      onStdoutChunk: (chunk) => output.push(chunk),
    });

    expect(result).toEqual({
      success: true,
      stdout: "devbox rebuilt\n",
      stderr: "",
      exitCode: 0,
    });
    expect(output).toEqual(["devbox ", "rebuilt\n"]);
    expect(statusRequests).toBe(2);
    client.closeSession();
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
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
            protocolVersion: 1,
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
          protocolVersion: 1,
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
      workerEncryptionPublicKey: null,
      workerTlsCertificate: null,
      workerTlsFingerprint: null,
      workerDirectory: "/workspace",
      workerCapabilities: DEFAULT_EXECUTION_HOST_CAPABILITIES,
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
            protocolVersion: 1,
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
            protocolVersion: 1,
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
          protocolVersion: 1,
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
});
