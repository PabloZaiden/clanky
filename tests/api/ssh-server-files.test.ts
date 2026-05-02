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
  let alternateRootDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-data-"));
    workDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-work-"));
    alternateRootDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-alt-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Server files\n");
    await writeFile(join(workDir, "src", "index.ts"), "export const serverValue = 1;\n");
    await writeFile(join(workDir, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
    await mkdir(join(alternateRootDir, "logs"), { recursive: true });
    await writeFile(join(alternateRootDir, "logs", "output.log"), "server alt root\n");

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
    await rm(alternateRootDir, { recursive: true, force: true });
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
    expect(listData.entries.map((entry) => entry.name)).toEqual(["src", "logo.svg", "README.md"]);

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

  test("previews browser-renderable server images with credential and image headers", async () => {
    const createdServer = await createServer();

    const missingCredentialResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/preview?path=${encodeURIComponent("logo.svg")}`,
    );
    expect(missingCredentialResponse.status).toBe(400);
    const missingCredentialData = await missingCredentialResponse.json() as { error: string; message: string };
    expect(missingCredentialData.error).toBe("invalid_credential_token");
    expect(missingCredentialData.message).toBe("SSH credential token is required for standalone server file access");

    const previewToken = await issueCredentialToken(createdServer.config.id);
    const previewResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/preview?path=${encodeURIComponent("logo.svg")}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": previewToken,
        },
      },
    );

    expect(previewResponse.ok).toBe(true);
    expect(previewResponse.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(previewResponse.headers.get("Content-Disposition")).toBe("inline; filename=\"logo.svg\"");
    expect(await previewResponse.text()).toContain("<svg");
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
        overwrite: false,
        startDirectory: null,
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

  test("returns not_found when the standalone server does not exist", async () => {
    const response = await fetch(`${baseUrl}/api/ssh-servers/missing-server/files`, {
      headers: {
        "x-ralpher-ssh-credential-token": "token-123",
      },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "not_found",
      message: "SSH server not found: missing-server",
    });
  });

  test("can use an alternate absolute start directory for standalone server operations", async () => {
    const createdServer = await createServer();
    const startDirectory = encodeURIComponent(alternateRootDir);

    const listToken = await issueCredentialToken(createdServer.config.id);
    const listResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files?startDirectory=${startDirectory}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": listToken,
        },
      },
    );
    expect(listResponse.ok).toBe(true);
    const listData = await listResponse.json() as {
      entries: Array<{ name: string }>;
    };
    expect(listData.entries.map((entry) => entry.name)).toEqual(["logs"]);

    const metadataToken = await issueCredentialToken(createdServer.config.id);
    const metadataResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/metadata?path=${encodeURIComponent("logs/output.log")}&startDirectory=${startDirectory}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": metadataToken,
        },
      },
    );
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    const writeToken = await issueCredentialToken(createdServer.config.id);
    const writeResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ralpher-ssh-credential-token": writeToken,
      },
      body: JSON.stringify({
        path: "logs/output.log",
        content: "server alt root updated\n",
        expectedVersionToken: metadata.file.versionToken,
        overwrite: false,
        startDirectory: alternateRootDir,
      }),
    });
    expect(writeResponse.ok).toBe(true);

    const readToken = await issueCredentialToken(createdServer.config.id);
    const readResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/content?path=${encodeURIComponent("logs/output.log")}&startDirectory=${startDirectory}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": readToken,
        },
      },
    );
    const readData = await readResponse.json() as { content: string };
    expect(readData.content).toBe("server alt root updated\n");
  });

  test("reuses the same credential token across root changes and parent-directory navigation", async () => {
    const parentRootDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-files-parent-"));
    const configuredRootDir = join(parentRootDir, "project");
    try {
      await mkdir(join(configuredRootDir, "src"), { recursive: true });
      await writeFile(join(configuredRootDir, "src", "index.ts"), "export const nestedValue = 1;\n");
      await mkdir(join(parentRootDir, "shared"), { recursive: true });
      await writeFile(join(parentRootDir, "shared", "notes.txt"), "parent root\n");

      const response = await fetch(`${baseUrl}/api/ssh-servers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Server Files Parent Root",
          address: "ssh.example.com",
          username: "deploy",
          repositoriesBasePath: configuredRootDir,
        }),
      });
      expect(response.status).toBe(201);
      const createdServer = await response.json() as { config: { id: string } };

      const credentialToken = await issueCredentialToken(createdServer.config.id);

      const initialListResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files`, {
        headers: {
          "x-ralpher-ssh-credential-token": credentialToken,
        },
      });
      expect(initialListResponse.ok).toBe(true);
      const initialListData = await initialListResponse.json() as {
        entries: Array<{ name: string }>;
      };
      expect(initialListData.entries.map((entry) => entry.name)).toEqual(["src"]);

      const parentStartDirectory = encodeURIComponent(parentRootDir);
      const parentListResponse = await fetch(
        `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files?startDirectory=${parentStartDirectory}`,
        {
          headers: {
            "x-ralpher-ssh-credential-token": credentialToken,
          },
        },
      );
      expect(parentListResponse.ok).toBe(true);
      const parentListData = await parentListResponse.json() as {
        entries: Array<{ name: string }>;
      };
      expect(parentListData.entries.map((entry) => entry.name)).toEqual(["project", "shared"]);

      const parentReadResponse = await fetch(
        `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/content?path=${encodeURIComponent("shared/notes.txt")}&startDirectory=${parentStartDirectory}`,
        {
          headers: {
            "x-ralpher-ssh-credential-token": credentialToken,
          },
        },
      );
      expect(parentReadResponse.ok).toBe(true);
      expect(await parentReadResponse.json()).toMatchObject({
        content: "parent root\n",
        file: { path: "shared/notes.txt" },
      });
    } finally {
      await rm(parentRootDir, { recursive: true, force: true });
    }
  });

  test("returns an explicit error when the standalone server start directory does not exist", async () => {
    const createdServer = await createServer();
    const missingStartDirectory = encodeURIComponent(join(alternateRootDir, "missing-root"));
    const credentialToken = await issueCredentialToken(createdServer.config.id);

    const response = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files?startDirectory=${missingStartDirectory}`,
      {
        headers: {
          "x-ralpher-ssh-credential-token": credentialToken,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "start_directory_not_found",
    });
  });
});
