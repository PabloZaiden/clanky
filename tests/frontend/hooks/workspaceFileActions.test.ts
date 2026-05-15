import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getFileExplorerFileMetadataApi, listServerFilesApi, writeServerFileApi } from "@/hooks/workspaceFileActions";
import { clearStoredSshServerCredential, storeSshServerPassword } from "@/lib/ssh-browser-credentials";
import { createMockApi } from "../helpers/mock-api";

const api = createMockApi();
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsKNhd9E/OQ+lbqKlfYjv
69xGawOr9J0cMf2Qj3jWXaXv6mm1xrDBMYNboWkjxV6AZAG9zDJO6s8eP/rj7s3P
7dfmoHGRfqoItqqt6WkKxZxjrnDc0l43wcdGaGm0fL5f4enJv+0Ft9Y+BSHhMl+m
ENb+JvTFFK3bz38eLI8Td2RLIqjQ+bTR0M55VdlyIJvtZ4bAzn9IdABzd8hIp/Fq
ZI97s5nsyDqX5ePG7e9UY9kfF4sxhQ1jlwmkIYlQmVl3zY6fWihc+YVHL7XWE/90
cwJp+7qyc0w90j+5vMuJcfFm7F8FG7Zz+oOkkeNbeqMHEaJwVIi9vtHbljH5jtmd
Tib0ROswpXTuhp2cDEgfZiF5m6o6Yws1eIqUhYaEfpOUqseYjPe6Klbjyl90m7Xq
QpPbjq5q7UL/ase5r4n4t0JgcLZw1oP98rVAx+VFE+UViVd9qqH7CFhxxR9t7LFa
NwUWw/pj0oI3Qul2lJfXaogfXzdcguVRik/yi0zQ5p5ArRBPEtmeNcEqA9x1ApNQ
h8ND8r3lVAjFrX8+pj1fmPSxaIXgQPywAzr5kgdWz3BOEkrd5alvd+6kLxC2ErMA
tYXzrp47C+1F7elWjBhHsqlhHSl7zQxqXqetisXZ4uEyv+4S0M3O+Q+iLeidcbLQ
Vrt5VIv2q/QnK29KDywKJrsCAwEAAQ==
-----END PUBLIC KEY-----`;

beforeEach(() => {
  api.reset();
  api.install();
  window.localStorage.clear();
  clearStoredSshServerCredential("server-1");
});

afterEach(() => {
  api.uninstall();
});

describe("server file explorer actions", () => {
  test("limits concurrent metadata requests across file explorer targets", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const releaseRequestHandlers: Array<() => void> = [];

    api.get("/api/workspaces/:id/files/metadata", async (req) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise<void>((resolve) => {
        releaseRequestHandlers.push(resolve);
      });
      activeRequests -= 1;

      const path = new URL(req.url, "http://localhost").searchParams.get("path") ?? "";
      return {
        workspaceId: req.params["id"],
        file: {
          name: path.split("/").pop() ?? path,
          path,
          kind: "file",
          size: 1,
          modifiedAt: new Date().toISOString(),
          versionToken: `token-${path}`,
        },
      };
    });

    const requests = Array.from({ length: 25 }, (_value, index) =>
      getFileExplorerFileMetadataApi(
        { type: "workspace", id: "workspace-1" },
        `src/file-${index}.ts`,
      ));

    while (api.calls("/api/workspaces/:id/files/metadata", "GET").length < 25) {
      while (releaseRequestHandlers.length > 0) {
        releaseRequestHandlers.shift()?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    while (releaseRequestHandlers.length > 0) {
      releaseRequestHandlers.shift()?.();
    }

    await Promise.all(requests);

    expect(maxActiveRequests).toBe(10);
  });

  test("sends the exchanged credential token when listing server files", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files", (req) => {
      expect(req.params["id"]).toBe("server-1");
      expect(req.headers.get("x-ralpher-ssh-credential-token")).toBe("token-123");
      expect(new URL(req.url, "http://localhost").searchParams.get("startDirectory")).toBe("/srv/apps");
      return {
        serverId: "server-1",
        directory: "",
        entries: [],
      };
    });

    await storeSshServerPassword("server-1", "super-secret");
    const response = await listServerFilesApi("server-1", "", { startDirectory: "/srv/apps" });

    expect(response.serverId).toBe("server-1");
    expect(api.calls("/api/ssh-servers/:id/files", "GET")).toHaveLength(1);
  });

  test("writes server files through the standalone server endpoint", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-456",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.post("/api/ssh-servers/:id/files/write", (req) => {
      expect(req.params["id"]).toBe("server-1");
      expect(req.headers.get("x-ralpher-ssh-credential-token")).toBe("token-456");
      expect(req.body).toEqual({
        path: "src/index.ts",
        content: "export const value = 2;\n",
        expectedVersionToken: "token-a",
        overwrite: false,
        startDirectory: "/srv/apps",
      });
      return {
        success: true,
        serverId: "server-1",
        file: {
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 24,
          modifiedAt: new Date().toISOString(),
          versionToken: "token-b",
        },
        overwritten: false,
      };
    });

    await storeSshServerPassword("server-1", "super-secret");
    const response = await writeServerFileApi("server-1", {
      path: "src/index.ts",
      content: "export const value = 2;\n",
      expectedVersionToken: "token-a",
      overwrite: false,
      startDirectory: "/srv/apps",
    }, { startDirectory: "/srv/apps" });

    expect(response.serverId).toBe("server-1");
    expect(response.file.versionToken).toBe("token-b");
  });

  test("uses a target-agnostic fallback error message for server explorer requests", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-789",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files", () => null, 502);

    await storeSshServerPassword("server-1", "super-secret");

    await expect(listServerFilesApi("server-1")).rejects.toThrow(
      "File explorer request failed with status 502",
    );
  });
});
