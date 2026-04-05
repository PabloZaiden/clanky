import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { serve, type Server } from "bun";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { apiRoutes } from "../../src/api";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";

class SshServerApiExecutor extends TestCommandExecutor {
  constructor(
    private readonly options: {
      connectionAvailable?: boolean;
      bashAvailable?: boolean;
      dtachAvailable?: boolean;
      devboxAvailable?: boolean;
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
    return await super.exec(command, args, options);
  }
}

describe("Standalone SSH servers API integration", () => {
  let dataDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let executorFactory: () => TestCommandExecutor;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-servers-api-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;
    await ensureDataDirectories();
    executorFactory = () => new SshServerApiExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executorFactory());

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    sshServerManager.setExecutorFactoryForTesting(null);
    delete process.env["RALPHER_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    executorFactory = () => new SshServerApiExecutor();
    const db = getDatabase();
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
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string; name: string } };
    expect(session.config.name).toBe("Deploy shell");

    const getSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getSessionResponse.ok).toBe(true);
  });

  test("accepts legacy credential tokens when creating standalone SSH sessions", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialToken: "not-a-real-token",
        name: "Deploy shell",
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as {
      config: { id: string; name: string; connectionMode: string };
    };
    expect(session.config.name).toBe("Deploy shell");
    expect(session.config.connectionMode).toBe("dtach");

    const getSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`);
    expect(getSessionResponse.ok).toBe(true);
  });

  test("deletes direct standalone SSH sessions without requiring a request body", async () => {
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Shared host",
        address: "ssh.example.com",
        username: "deploy",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const createSessionResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Direct shell",
        connectionMode: "direct",
      }),
    });
    expect(createSessionResponse.status).toBe(201);
    const session = await createSessionResponse.json() as { config: { id: string } };

    const deleteSessionResponse = await fetch(`${baseUrl}/api/ssh-server-sessions/${session.config.id}`, {
      method: "DELETE",
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
    });
    expect(checkResponse.ok).toBe(true);
    const report = await checkResponse.json() as {
      summary: { status: string };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.summary.status).toBe("ready");
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["ssh_connection", "available"],
      ["bash", "available"],
      ["dtach", "available"],
      ["devbox", "available"],
    ]);
  });

  test("marks devbox as not applicable and reports missing dtach when needed", async () => {
    executorFactory = () => new SshServerApiExecutor({ dtachAvailable: false });
    const createServerResponse = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Terminal Host",
        address: "ssh.example.com",
        username: "deploy",
      }),
    });
    const createdServer = await createServerResponse.json() as { config: { id: string } };

    const checkResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/prerequisites/check`, {
      method: "POST",
    });
    expect(checkResponse.ok).toBe(true);
    const report = await checkResponse.json() as {
      summary: { status: string };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.summary.status).toBe("missing_requirements");
    expect(report.checks.find((check) => check.id === "dtach")?.status).toBe("missing");
    expect(report.checks.find((check) => check.id === "devbox")?.status).toBe("not_applicable");
  });
});
