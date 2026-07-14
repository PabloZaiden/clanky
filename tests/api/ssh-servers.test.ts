import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { MockAcpBackend } from "../mocks/mock-backend";

class SshServerApiExecutor extends TestCommandExecutor {
  constructor(
    private readonly options: {
      connectionAvailable?: boolean;
      bashAvailable?: boolean;
        dtachAvailable?: boolean;
        devboxAvailable?: boolean;
        devboxTemplatesOutput?: string;
        failDevboxTemplates?: boolean;
        dockerAvailable?: boolean;
        devcontainerAvailable?: boolean;
        gitAvailable?: boolean;
      ghAvailable?: boolean;
    } = {},
  ) {
    super();
  }

  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "true") {
      const available = this.options.connectionAvailable ?? true;
      return {
        success: available,
        stdout: "",
        stderr: available ? "" : "ssh connection failed",
        exitCode: available ? 0 : 255,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v bash")) {
      const available = this.options.bashAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/bin/bash\n" : "",
        stderr: available ? "" : "bash missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v devbox")) {
      const available = this.options.devboxAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/devbox\n" : "",
        stderr: available ? "" : "devbox missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v docker")) {
      const available = this.options.dockerAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/docker\n" : "",
        stderr: available ? "" : "docker missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v devcontainer")) {
      const available = this.options.devcontainerAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/devcontainer\n" : "",
        stderr: available ? "" : "devcontainer missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v git")) {
      const available = this.options.gitAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/git\n" : "",
        stderr: available ? "" : "git missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v gh")) {
      const available = this.options.ghAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/gh\n" : "",
        stderr: available ? "" : "gh missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v dtach")) {
      const available = this.options.dtachAvailable ?? true;
      return {
        success: available,
        stdout: available ? "dtach - version 0.9\n" : "",
        stderr: available ? "" : "dtach missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: true,
        stdout: "dtach - version 0.9\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "devbox" && args[0] === "templates") {
      if (this.options.failDevboxTemplates) {
        return {
          success: false,
          stdout: "",
          stderr: "devbox: command not found",
          exitCode: 127,
        };
      }
      return {
        success: true,
        stdout: this.options.devboxTemplatesOutput ?? JSON.stringify([
          {
            name: "python",
            description: "Python 3.14 on Debian bookworm.",
            source: "built-in",
            base: "bookworm",
            image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
            pinnedReference: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
            runtimeVersion: "Python 3.14",
            languages: ["python"],
            runnerCompatible: true,
          },
        ]),
        stderr: "",
        exitCode: 0,
      };
    }
    return await super.exec(command, args, options);
  }
}

class FailingStandalonePersistentCleanupExecutor extends SshServerApiExecutor {
  override async exec(command: string, args: string[], options?: Parameters<SshServerApiExecutor["exec"]>[2]) {
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes(".dtach.sock")) {
      return {
        success: false,
        stdout: "",
        stderr: "ssh connection failed",
        exitCode: 255,
      };
    }
    return await super.exec(command, args, options);
  }
}

describe("Standalone SSH servers API integration", () => {
  let dataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let executorFactory: () => TestCommandExecutor;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-ssh-servers-api-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await ensureDataDirectories();
    executorFactory = () => new SshServerApiExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executorFactory());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    sshServerManager.setExecutorFactoryForTesting(null);
    backendManager.resetForTesting();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    executorFactory = () => new SshServerApiExecutor();
    backendManager.resetForTesting();
    const db = getDatabase();
    db.run("DELETE FROM chats");
    db.run("DELETE FROM ssh_server_sessions");
    db.run("DELETE FROM ssh_servers");
  });

  async function createEncryptedCredential(serverId: string, password = "secret") {
    const publicKeyResponse = await fetch(`${baseUrl}/api/ssh-servers/${serverId}/public-key`);
    expect(publicKeyResponse.ok).toBe(true);
    const publicKey = await publicKeyResponse.json() as {
      algorithm: "RSA-OAEP-256";
      publicKey: string;
      fingerprint: string;
      version: number;
    };

    return {
      encryptedCredential: {
        algorithm: publicKey.algorithm,
        fingerprint: publicKey.fingerprint,
        version: publicKey.version,
        ciphertext: publicEncrypt({
          key: publicKey.publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        }, Buffer.from(password, "utf8")).toString("base64"),
      },
    };
  }

  test("creates, lists, updates, and deletes standalone SSH servers", async () => {
    const createResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { config: { id: string; name: string } };

    const listResponse = await fetch(`${baseUrl}/api/ssh-servers`);
    expect(listResponse.ok).toBe(true);
    const servers = await listResponse.json() as Array<{ config: { id: string } }>;
    expect(servers).toHaveLength(1);
    expect(servers[0]?.config.id).toBe(created.config.id);

    const updateResponse = await fetch(`${baseUrl}/api/ssh-servers/${created.config.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed host",
        address: "ssh.internal.example",
        username: "builder",
        repositoriesBasePath: "/srv/repos",
      }),
    });
    expect(updateResponse.ok).toBe(true);
    const updated = await updateResponse.json() as {
      config: {
        name: string;
        address: string;
        username: string;
        repositoriesBasePath?: string;
      };
    };
    expect(updated.config.name).toBe("Renamed host");
    expect(updated.config.address).toBe("ssh.internal.example");
    expect(updated.config.username).toBe("builder");
    expect(updated.config.repositoriesBasePath).toBe("/srv/repos");

    const deleteResponse = await fetch(`${baseUrl}/api/ssh-servers/${created.config.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.ok).toBe(true);
  });

  test("exchanges encrypted credentials and creates a standalone SSH session", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const credentialResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await createEncryptedCredential(createdServer.config.id)),
    });
    expect(credentialResponse.status).toBe(201);
    const exchange = await credentialResponse.json() as { credentialToken: string };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: exchange.credentialToken,
        name: "Deploy shell",
        connectionMode: "dtach",
        useTmux: false,
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string; name: string; useTmux: boolean } };
    expect(session.config.name).toBe("Deploy shell");
    expect(session.config.useTmux).toBe(false);

    const getSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getSessionResponse.ok).toBe(true);
  });

  test("creates a standalone SSH session with a null credential token for direct mode", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: null,
        name: "Direct shell",
        connectionMode: "direct",
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as {
      config: { id: string; name: string; connectionMode: string; useTmux: boolean };
    };
    expect(session.config.name).toBe("Direct shell");
    expect(session.config.connectionMode).toBe("direct");
    expect(session.config.useTmux).toBe(false);
  });

  test("deletes a standalone persistent SSH session without requiring credentials", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Unreachable host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: null,
        name: "Persistent shell",
        connectionMode: "dtach",
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string } };

    const deleteResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });

    expect(deleteResponse.ok).toBe(true);
    expect(await deleteResponse.json()).toEqual({ success: true });

    const getResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getResponse.status).toBe(404);
  });

  test("deletes a standalone persistent SSH session when remote cleanup fails", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cleanup failure host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const credentialResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await createEncryptedCredential(createdServer.config.id)),
    });
    expect(credentialResponse.status).toBe(201);
    const exchange = await credentialResponse.json() as { credentialToken: string };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: exchange.credentialToken,
        name: "Persistent shell",
        connectionMode: "dtach",
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string } };

    executorFactory = () => new FailingStandalonePersistentCleanupExecutor();

    const deleteResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: exchange.credentialToken }),
    });

    expect(deleteResponse.ok).toBe(true);
    expect(await deleteResponse.json()).toEqual({ success: true });

    const getResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getResponse.status).toBe(404);
  });

  test("creates and lists SSH-server-owned chats", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Chat host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createChatResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/chats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Remote investigation",
        directory: "/workspaces/project",
        model: { providerID: "copilot", modelID: "gpt-5.5", variant: "" },
        autoApprovePermissions: true,
      }),
    });
    expect(createChatResponse.status).toBe(201);
    const chat = await createChatResponse.json() as {
      config: {
        id: string;
        workspaceId: string;
        source: { kind: string; sshServerId: string; directory: string };
      };
      state: { connectionStatus: string };
    };
    expect(chat.config.workspaceId).toBe("");
    expect(chat.config.source).toMatchObject({
      kind: "ssh_server",
      sshServerId: createdServer.config.id,
      directory: "/workspaces/project",
    });
    expect(chat.state.connectionStatus).toBe("needs_credentials");

    const listChatsResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/chats`);
    expect(listChatsResponse.ok).toBe(true);
    const chats = await listChatsResponse.json() as Array<{ config: { id: string } }>;
    expect(chats.map((item) => item.config.id)).toEqual([chat.config.id]);

    const reconnectResponse = await fetch(`${baseUrl}/api/chats/${chat.config.id}/reconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(reconnectResponse.status).toBe(400);
    await expect(reconnectResponse.json()).resolves.toMatchObject({
      error: "ssh_credentials_required",
    });

    const getChatResponse = await fetch(`${baseUrl}/api/chats/${chat.config.id}`);
    expect(getChatResponse.ok).toBe(true);
    const reconnectFailedChat = await getChatResponse.json() as {
      state: { connectionStatus: string; error?: { code?: string } };
    };
    expect(reconnectFailedChat.state.connectionStatus).toBe("needs_credentials");
    expect(reconnectFailedChat.state.error?.code).toBe("ssh_credentials_required");
  });

  test("discovers SSH-server chat models through shared ACP settings for the selected provider", async () => {
    const mockBackend = new MockAcpBackend({
      filterModelsByConnectionProvider: true,
      models: [
        {
          providerID: "copilot",
          providerName: "Copilot",
          modelID: "claude-from-copilot-runtime",
          modelName: "Claude From Copilot Runtime",
          connected: true,
          variants: ["low"],
        },
        {
          providerID: "codex",
          providerName: "Codex",
          modelID: "gpt-from-codex-runtime",
          modelName: "GPT From Codex Runtime",
          connected: true,
          variants: [""],
        },
      ],
    });
    backendManager.setBackendForTesting(mockBackend);

    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Model Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const credentialResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await createEncryptedCredential(createdServer.config.id)),
    });
    const exchange = await credentialResponse.json() as { credentialToken: string };

    const copilotResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/chat-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: exchange.credentialToken,
        providerID: "copilot",
        directory: "/workspaces/project",
      }),
    });
    expect(copilotResponse.ok).toBe(true);
    const copilotModels = await copilotResponse.json() as Array<{ providerID: string; providerName: string; modelID: string }>;
    expect(copilotModels.map((model) => ({
      providerID: model.providerID,
      providerName: model.providerName,
      modelID: model.modelID,
    }))).toEqual([
      { providerID: "copilot", providerName: "Copilot", modelID: "claude-from-copilot-runtime" },
    ]);

    const codexResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/chat-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: exchange.credentialToken,
        providerID: "codex",
        directory: "/workspaces/project",
      }),
    });
    expect(codexResponse.ok).toBe(true);
    const codexModels = await codexResponse.json() as Array<{ providerID: string; providerName: string; modelID: string }>;
    expect(codexModels.map((model) => ({
      providerID: model.providerID,
      providerName: model.providerName,
      modelID: model.modelID,
    }))).toEqual([
      { providerID: "codex", providerName: "Codex", modelID: "gpt-from-codex-runtime" },
    ]);
  });

  test("deletes direct standalone SSH sessions", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Direct shell",
        connectionMode: "direct",
        credentialToken: null,
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string } };

    const deleteSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(deleteSessionResponse.ok).toBe(true);

    const getDeletedSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getDeletedSessionResponse.status).toBe(404);
  });

  test("checks standalone SSH server prerequisites through the API", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Provision Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const checkResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/prerequisites/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(checkResponse.ok).toBe(true);
    const report = await checkResponse.json() as {
      summary: { status: string; notApplicableCount: number };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.summary.status).toBe("ready");
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["ssh_connection", "available"],
      ["bash", "available"],
      ["dtach", "available"],
      ["devbox", "available"],
      ["docker", "available"],
      ["devcontainer", "available"],
      ["git", "available"],
      ["gh", "available"],
    ]);
  });

  test("marks automatic provisioning requirements as not applicable and reports missing dtach when needed", async () => {
    executorFactory = () => new SshServerApiExecutor({ dtachAvailable: false });
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Terminal Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: null,
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const checkResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/prerequisites/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(checkResponse.ok).toBe(true);
    const report = await checkResponse.json() as {
      summary: { status: string; notApplicableCount: number };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.summary.status).toBe("missing_requirements");
    expect(report.checks.find((check) => check.id === "dtach")?.status).toBe("missing");
    expect(report.summary.notApplicableCount).toBe(5);
    expect(
      report.checks
        .filter((check) => ["devbox", "docker", "devcontainer", "git", "gh"].includes(check.id))
        .every((check) => check.status === "not_applicable"),
    ).toBe(true);
  });

  test("lists devbox templates through the API", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Template Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const templatesResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/devbox/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(templatesResponse.ok).toBe(true);
    const templates = await templatesResponse.json() as Array<{
      description: string;
      source: string;
      base: string;
      image: string | null;
      pinnedReference: string;
      name: string;
      runtimeVersion: string;
      languages: string[];
      runnerCompatible: boolean;
    }>;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual({
      description: "Python 3.14 on Debian bookworm.",
      source: "built-in",
      base: "bookworm",
      image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
      pinnedReference: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
      name: "python",
      runtimeVersion: "Python 3.14",
      languages: ["python"],
      runnerCompatible: true,
    });
  });

  test("returns 404 when listing devbox templates for an unknown server", async () => {
    const response = await fetch(`${baseUrl}/api/ssh-servers/missing-server/devbox/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(response.status).toBe(404);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("returns 400 when listing devbox templates with an invalid credential token", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Template Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const templatesResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/devbox/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: "invalid-token" }),
    });
    expect(templatesResponse.status).toBe(400);
    const body = await templatesResponse.json() as { error: string };
    expect(body.error).toBe("invalid_credential_token");
  });

  test("returns 500 when devbox templates output is invalid JSON", async () => {
    executorFactory = () => new SshServerApiExecutor({ devboxTemplatesOutput: "not json" });
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Template Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const templatesResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/devbox/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(templatesResponse.status).toBe(500);
    const body = await templatesResponse.json() as { error: string; message: string };
    expect(body.error).toBe("ssh_server_error");
    expect(body.message).toBe("SSH server operation failed");
    expect(body.message).not.toContain("Failed to parse devbox templates output as JSON");
  });

  test("returns 500 when devbox templates cannot be listed", async () => {
    executorFactory = () => new SshServerApiExecutor({ failDevboxTemplates: true });
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Template Host",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: "/workspaces",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const templatesResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/devbox/templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialToken: null }),
    });
    expect(templatesResponse.status).toBe(500);
    const body = await templatesResponse.json() as { error: string; message: string };
    expect(body.error).toBe("ssh_server_templates_failed");
    expect(body.message).toBe("Failed to list devbox templates");
    expect(body.message).not.toContain("devbox: command not found");
  });
});
