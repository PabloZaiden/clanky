import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { serve, type Server } from "bun";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { apiRoutes } from "../../src/api";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("Standalone SSH server files API integration", () => {
  let dataDir: string;
  let workDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-data-"));
    workDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-work-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Server files\n");
    await writeFile(join(workDir, "src", "index.ts"), "export const serverValue = 1;\n");

    sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

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
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const db = getDatabase();
    db.run("DELETE FROM ssh_server_sessions");
    db.run("DELETE FROM ssh_servers");
  });

  async function createServer() {
    const response = await fetch(`${baseUrl}/api/ssh-servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Server Files",
        address: "ssh.example.com",
        username: "deploy",
        repositoriesBasePath: workDir,
      }),
    });
    expect(response.status).toBe(201);
    return await response.json() as { config: { id: string } };
  }

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

  async function issueCredentialToken(serverId: string): Promise<string> {
    const credentialResponse = await fetch(`${baseUrl}/api/ssh-servers/${serverId}/credentials`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await createEncryptedCredential(serverId)),
    });
    expect(credentialResponse.status).toBe(201);
    const exchange = await credentialResponse.json() as { credentialToken: string };
    return exchange.credentialToken;
  }

  test("lists and reads files directly on a standalone server", async () => {
    const createdServer = await createServer();
    const credentialToken = await issueCredentialToken(createdServer.config.id);

    const listResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files`, {
      headers: {
        "x-ralpher-ssh-credential-token": credentialToken,
      },
    });
    expect(listResponse.ok).toBe(true);

    const listData = await listResponse.json() as {
      serverId: string;
      directory: string;
      entries: Array<{ name: string; path: string; kind: string; versionToken: string }>;
    };
    expect(listData.serverId).toBe(createdServer.config.id);
    expect(listData.directory).toBe("");
    expect(listData.entries.map((entry) => entry.name)).toEqual(["src", "README.md"]);

    const readToken = await issueCredentialToken(createdServer.config.id);
    const readResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/content?path=${encodeURIComponent("src/index.ts")}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": readToken,
        },
      },
    );
    expect(readResponse.ok).toBe(true);

    const readData = await readResponse.json() as {
      serverId: string;
      content: string;
      file: { path: string; kind: string };
    };
    expect(readData.serverId).toBe(createdServer.config.id);
    expect(readData.file.path).toBe("src/index.ts");
    expect(readData.content).toContain("serverValue = 1");
  });

  test("writes files on a standalone server and rejects escaping paths", async () => {
    const createdServer = await createServer();
    const metadataToken = await issueCredentialToken(createdServer.config.id);
    const metadataResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/metadata?path=${encodeURIComponent("src/index.ts")}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": metadataToken,
        },
      },
    );
    expect(metadataResponse.ok).toBe(true);
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    const writeToken = await issueCredentialToken(createdServer.config.id);
    const writeResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ralpher-ssh-credential-token": writeToken,
      },
      body: JSON.stringify({
        path: "src/index.ts",
        content: "export const serverValue = 2;\n",
        expectedVersionToken: metadata.file.versionToken,
      }),
    });
    expect(writeResponse.ok).toBe(true);

    const readToken = await issueCredentialToken(createdServer.config.id);
    const readResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/content?path=${encodeURIComponent("src/index.ts")}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": readToken,
        },
      },
    );
    const readData = await readResponse.json() as { content: string };
    expect(readData.content).toContain("serverValue = 2");

    const invalidPathToken = await issueCredentialToken(createdServer.config.id);
    const invalidPathResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/content?path=${encodeURIComponent("../outside.txt")}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": invalidPathToken,
        },
      },
    );
    expect(invalidPathResponse.status).toBe(400);
    const invalidPathData = await invalidPathResponse.json() as { error: string };
    expect(invalidPathData.error).toBe("invalid_server_path");
  });
});
