import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat, ExecutionHostDescriptor, WorkspaceTerminalSession } from "@/shared";
import { initializeDatabase } from "../../src/persistence/database";
import { serveNativeApiRoutes } from "../native-api-server";

describe("Execution hosts API", () => {
  let server: Server<unknown>;
  let baseUrl: string;
  let testDataDir: string;

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-execution-hosts-api-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await initializeDatabase();
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    await rm(testDataDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("lists the local host and creates a direct host chat", async () => {
    const listResponse = await fetch(`${baseUrl}/api/execution-hosts`);
    expect(listResponse.status).toBe(200);
    const hosts = await listResponse.json() as ExecutionHostDescriptor[];
    const localHost = hosts.find((host) => host.ref.kind === "local");
    expect(localHost).toBeDefined();
    expect(localHost?.accessRequirement).toEqual({ kind: "none" });

    const createResponse = await fetch(
      `${baseUrl}/api/execution-hosts/local/${localHost!.ref.kind === "local" ? localHost!.ref.nodeId : ""}/chats`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Direct local chat",
          directory: testDataDir,
          model: {
            providerID: "copilot",
            modelID: "default",
            variant: "",
          },
          autoApprovePermissions: true,
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const chat = await createResponse.json() as Chat;
    expect(chat.config.source).toEqual({
      kind: "execution_host",
      executionHost: {
        host: localHost!.ref,
        targetKey: localHost!.targetKey,
        revision: localHost!.revision,
      },
      directory: testDataDir,
    });

    const getResponse = await fetch(`${baseUrl}/api/chats/${chat.config.id}`);
    expect(getResponse.status).toBe(200);
    const persisted = await getResponse.json() as Chat;
    expect(persisted.config.source).toEqual(chat.config.source);

    const createTerminalResponse = await fetch(`${baseUrl}/api/terminal-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        executionHost: localHost!.ref,
        name: "Direct local terminal",
        directory: testDataDir,
        connectionMode: "direct",
      }),
    });
    expect(createTerminalResponse.status).toBe(201);
    const terminal = await createTerminalResponse.json() as WorkspaceTerminalSession;
    expect(terminal.config.workspaceId).toBeUndefined();
    expect(terminal.config.executionHostBinding).toEqual({
      host: localHost!.ref,
      targetKey: localHost!.targetKey,
      revision: localHost!.revision,
    });

    const getTerminalResponse = await fetch(
      `${baseUrl}/api/terminal-sessions/${terminal.config.id}`,
    );
    expect(getTerminalResponse.status).toBe(200);
    const persistedTerminal = await getTerminalResponse.json() as WorkspaceTerminalSession;
    expect(persistedTerminal.config.executionHostBinding).toEqual(
      terminal.config.executionHostBinding,
    );

    const createVncResponse = await fetch(
      `${baseUrl}/api/execution-hosts/local/${localHost!.ref.kind === "local" ? localHost!.ref.nodeId : ""}/vnc-sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remotePort: 5900,
          credentialToken: null,
        }),
      },
    );
    expect(createVncResponse.status).toBe(201);
    const vncSession = await createVncResponse.json() as {
      config: { executionHostBinding?: unknown; sshServerId?: string };
      state: { status: string };
    };
    expect(vncSession.config.executionHostBinding).toEqual(
      terminal.config.executionHostBinding,
    );
    expect(vncSession.config.sshServerId).toBeUndefined();
    expect(vncSession.state.status).toBe("active");
  });

});
