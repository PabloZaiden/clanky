import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { getDatabase, initializeDatabase } from "../../src/persistence/database";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("Standalone SSH server files API integration", () => {
  let dataDir: string;
  let workDir: string;
  let alternateRootDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-files-data-"));
    workDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-files-work-"));
    alternateRootDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-files-alt-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await initializeDatabase();
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Server files\n");
    await writeFile(join(workDir, "src", "index.ts"), "export const serverValue = 1;\n");
    await writeFile(join(workDir, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
    await mkdir(join(alternateRootDir, "logs"), { recursive: true });
    await writeFile(join(alternateRootDir, "logs", "output.log"), "server alt root\n");

    sshServerManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    sshServerManager.setExecutorFactoryForTesting(null);
    delete process.env["CLANKY_DATA_DIR"];
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
        "x-clanky-ssh-credential-token": credentialToken,
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
          "x-clanky-ssh-credential-token": readToken,
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
          "x-clanky-ssh-credential-token": previewToken,
        },
      },
    );

    expect(previewResponse.ok).toBe(true);
    expect(previewResponse.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(previewResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(previewResponse.headers.get("Content-Disposition")).toBe("inline; filename=\"logo.svg\"");
    expect(await previewResponse.text()).toContain("<svg");
  });

  test("downloads standalone server files as attachments with credentials", async () => {
    const createdServer = await createServer();
    const missingCredentialResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/download?path=${encodeURIComponent("README.md")}`,
    );
    expect(missingCredentialResponse.status).toBe(400);

    const credentialToken = await issueCredentialToken(createdServer.config.id);
    const metadataResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/metadata?path=${encodeURIComponent("README.md")}`,
      {
        headers: {
          "x-clanky-ssh-credential-token": credentialToken,
        },
      },
    );
    expect(metadataResponse.ok).toBe(true);
    const metadata = await metadataResponse.json() as {
      file: { name: string; path: string; kind: string; size: number };
    };
    expect(metadata.file).toMatchObject({
      name: "README.md",
      path: "README.md",
      kind: "file",
      size: "# Server files\n".length,
    });

    const downloadUrl =
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/download?path=${encodeURIComponent("README.md")}`;
    const headToken = await issueCredentialToken(createdServer.config.id);
    const headResponse = await fetch(downloadUrl, {
      method: "HEAD",
      headers: {
        "x-clanky-ssh-credential-token": headToken,
      },
    });
    expect(headResponse.ok).toBe(true);
    expect(headResponse.headers.get("Content-Disposition")).toContain("attachment; filename=\"README.md\"");
    expect(headResponse.headers.get("Content-Length")).toBe(String(metadata.file.size));
    expect(headResponse.headers.get("X-Clanky-Download-Size")).toBe(String(metadata.file.size));

    const downloadToken = await issueCredentialToken(createdServer.config.id);
    const response = await fetch(
      downloadUrl,
      {
        headers: {
          "x-clanky-ssh-credential-token": downloadToken,
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain("attachment; filename=\"README.md\"");
    expect(response.headers.get("Content-Length")).toBe(String(metadata.file.size));
    expect(response.headers.get("X-Clanky-Download-Size")).toBe(String(metadata.file.size));
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Content-Length");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Clanky-Download-Size");
    expect(await response.text()).toBe("# Server files\n");

    const queryToken = await issueCredentialToken(createdServer.config.id);
    const queryResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/download?path=${encodeURIComponent("README.md")}&credentialToken=${encodeURIComponent(queryToken)}`,
    );
    expect(queryResponse.ok).toBe(true);
    expect(queryResponse.headers.get("Content-Disposition")).toContain("attachment; filename=\"README.md\"");
    expect(await queryResponse.text()).toBe("# Server files\n");
  });

  test("writes files on a standalone server and rejects escaping paths", async () => {
    const createdServer = await createServer();
    const metadataToken = await issueCredentialToken(createdServer.config.id);
    const metadataResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/metadata?path=${encodeURIComponent("src/index.ts")}`,
      {
        headers: {
          "x-clanky-ssh-credential-token": metadataToken,
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
        "x-clanky-ssh-credential-token": writeToken,
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
          "x-clanky-ssh-credential-token": readToken,
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
          "x-clanky-ssh-credential-token": invalidPathToken,
        },
      },
    );
    expect(invalidPathResponse.status).toBe(400);
    const invalidPathData = await invalidPathResponse.json() as { error: string };
    expect(invalidPathData.error).toBe("invalid_server_path");
  });

  test("renames and deletes standalone server files and directories with credentials", async () => {
    const createdServer = await createServer();
    await mkdir(join(workDir, "server-dir", "child"), { recursive: true });
    await writeFile(join(workDir, "server-dir", "child", "note.txt"), "server nested note\n");

    const renameFileToken = await issueCredentialToken(createdServer.config.id);
    const renameFileResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/rename`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": renameFileToken,
      },
      body: JSON.stringify({
        path: "README.md",
        newName: "README-server-renamed.md",
      }),
    });
    expect(renameFileResponse.ok).toBe(true);
    expect(await Bun.file(join(workDir, "README-server-renamed.md")).text()).toBe("# Server files\n");

    const renameDirectoryToken = await issueCredentialToken(createdServer.config.id);
    const renameDirectoryResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/rename`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": renameDirectoryToken,
      },
      body: JSON.stringify({
        path: "server-dir",
        newName: "server-renamed-dir",
      }),
    });
    expect(renameDirectoryResponse.ok).toBe(true);
    expect(await Bun.file(join(workDir, "server-renamed-dir", "child", "note.txt")).text()).toBe("server nested note\n");

    const deleteFileToken = await issueCredentialToken(createdServer.config.id);
    const deleteFileResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": deleteFileToken,
      },
      body: JSON.stringify({
        path: "README-server-renamed.md",
        kind: "file",
      }),
    });
    expect(deleteFileResponse.ok).toBe(true);
    expect(await Bun.file(join(workDir, "README-server-renamed.md")).exists()).toBe(false);

    const deleteDirectoryToken = await issueCredentialToken(createdServer.config.id);
    const deleteDirectoryResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": deleteDirectoryToken,
      },
      body: JSON.stringify({
        path: "server-renamed-dir",
        kind: "directory",
      }),
    });
    expect(deleteDirectoryResponse.ok).toBe(true);
    expect(await Bun.file(join(workDir, "server-renamed-dir", "child", "note.txt")).exists()).toBe(false);
  });

  test("uploads standalone server files in chunks with credentials", async () => {
    const createdServer = await createServer();

    const createToken = await issueCredentialToken(createdServer.config.id);
    const createResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": createToken,
      },
      body: JSON.stringify({
        directory: "src",
        fileName: "server-uploaded.txt",
        size: 12,
        overwrite: false,
      }),
    });
    expect(createResponse.status).toBe(201);
    const session = await createResponse.json() as { uploadId: string };

    const firstChunkToken = await issueCredentialToken(createdServer.config.id);
    const firstChunkResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=0`,
      {
        method: "POST",
        headers: {
          "x-clanky-ssh-credential-token": firstChunkToken,
        },
        body: new Blob(["server "]),
      },
    );
    expect(firstChunkResponse.ok).toBe(true);
    expect(await firstChunkResponse.json()).toMatchObject({ nextOffset: 7 });

    const secondChunkToken = await issueCredentialToken(createdServer.config.id);
    const secondChunkResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=7`,
      {
        method: "POST",
        headers: {
          "x-clanky-ssh-credential-token": secondChunkToken,
        },
        body: new Blob(["chunk"]),
      },
    );
    expect(secondChunkResponse.ok).toBe(true);
    expect(await secondChunkResponse.json()).toMatchObject({ nextOffset: 12 });

    const completeToken = await issueCredentialToken(createdServer.config.id);
    const completeResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": completeToken,
      },
      body: JSON.stringify({ uploadId: session.uploadId }),
    });
    expect(completeResponse.ok).toBe(true);
    expect(await Bun.file(join(workDir, "src", "server-uploaded.txt")).text()).toBe("server chunk");
    expect(await Bun.file(join(workDir, ".clanky-upload-tmp")).exists()).toBe(false);
  });

  test("accepts standalone server upload chunks larger than the legacy 800 KiB limit", async () => {
    const createdServer = await createServer();
    const firstChunk = new Uint8Array(8 * 1024 * 1024);
    firstChunk.fill(0x3c);
    const secondChunk = new Uint8Array([10, 20, 30, 40, 250]);
    const expected = new Uint8Array(firstChunk.byteLength + secondChunk.byteLength);
    expected.set(firstChunk);
    expected.set(secondChunk, firstChunk.byteLength);

    const createToken = await issueCredentialToken(createdServer.config.id);
    const createResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": createToken,
      },
      body: JSON.stringify({
        directory: "src",
        fileName: "large-server-upload.bin",
        size: expected.byteLength,
        overwrite: false,
      }),
    });
    expect(createResponse.status).toBe(201);
    const session = await createResponse.json() as { uploadId: string };

    const firstChunkToken = await issueCredentialToken(createdServer.config.id);
    const firstChunkResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=0`,
      {
        method: "POST",
        headers: {
          "x-clanky-ssh-credential-token": firstChunkToken,
        },
        body: new Blob([firstChunk]),
      },
    );
    expect(firstChunkResponse.ok).toBe(true);
    expect(await firstChunkResponse.json()).toMatchObject({ nextOffset: firstChunk.byteLength });

    const secondChunkToken = await issueCredentialToken(createdServer.config.id);
    const secondChunkResponse = await fetch(
      `${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=${firstChunk.byteLength}`,
      {
        method: "POST",
        headers: {
          "x-clanky-ssh-credential-token": secondChunkToken,
        },
        body: new Blob([secondChunk]),
      },
    );
    expect(secondChunkResponse.ok).toBe(true);
    expect(await secondChunkResponse.json()).toMatchObject({ nextOffset: expected.byteLength });

    const completeToken = await issueCredentialToken(createdServer.config.id);
    const completeResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/upload/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": completeToken,
      },
      body: JSON.stringify({ uploadId: session.uploadId }),
    });
    expect(completeResponse.ok).toBe(true);
    const uploaded = new Uint8Array(await Bun.file(join(workDir, "src", "large-server-upload.bin")).arrayBuffer());
    expect(uploaded).toEqual(expected);
    expect(await Bun.file(join(workDir, ".clanky-upload-tmp")).exists()).toBe(false);
  });

  test("returns not_found when the standalone server does not exist", async () => {
    const response = await fetch(`${baseUrl}/api/ssh-servers/missing-server/files`, {
      headers: {
        "x-clanky-ssh-credential-token": "token-123",
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
          "x-clanky-ssh-credential-token": listToken,
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
          "x-clanky-ssh-credential-token": metadataToken,
        },
      },
    );
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    const writeToken = await issueCredentialToken(createdServer.config.id);
    const writeResponse = await fetch(`${baseUrl}/api/ssh-servers/${createdServer.config.id}/files/write`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clanky-ssh-credential-token": writeToken,
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
          "x-clanky-ssh-credential-token": readToken,
        },
      },
    );
    const readData = await readResponse.json() as { content: string };
    expect(readData.content).toBe("server alt root updated\n");
  });

  test("reuses the same credential token across root changes and parent-directory navigation", async () => {
    const parentRootDir = await mkdtemp(join(tmpdir(), "clanky-ssh-server-files-parent-"));
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
          "x-clanky-ssh-credential-token": credentialToken,
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
            "x-clanky-ssh-credential-token": credentialToken,
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
            "x-clanky-ssh-credential-token": credentialToken,
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
          "x-clanky-ssh-credential-token": credentialToken,
        },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "start_directory_not_found",
    });
  });
});
