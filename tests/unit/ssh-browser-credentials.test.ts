import { describe, expect, test } from "bun:test";

import {
  clearStoredSshServerCredential,
  encryptSshServerPassword,
  getStoredSshCredentialToken,
  getStoredSshServerCredential,
  saveStoredSshServerCredential,
  storeSshServerPassword,
} from "../../src/lib/ssh-browser-credentials";
import type { SshServerPublicKey } from "../../src/types";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

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

const TEST_PUBLIC_KEY_RESPONSE: SshServerPublicKey = {
  algorithm: "RSA-OAEP-256",
  publicKey: TEST_PUBLIC_KEY,
  fingerprint: "fingerprint-v1",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ssh-browser-credentials", () => {
  test("stores an encrypted password locally without persisting the raw password", async () => {
    const storage = new MemoryStorage();
    const record = await storeSshServerPassword("server-1", "super-secret", {
      storage,
      fetchFn: async () => createJsonResponse(TEST_PUBLIC_KEY_RESPONSE),
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(record.storedAt).toBe("2026-01-02T03:04:05.000Z");
    expect(record.encryptedCredential.ciphertext).not.toBe("super-secret");
    expect(storage.getItem("ralpher.sshServerCredential.server-1")).not.toContain("super-secret");
  });

  test("returns a token from a compatible stored credential", async () => {
    const storage = new MemoryStorage();
    const encryptedCredential = await encryptSshServerPassword("secret", TEST_PUBLIC_KEY_RESPONSE);
    saveStoredSshServerCredential("server-1", encryptedCredential, { storage });

    const calls: string[] = [];
    const token = await getStoredSshCredentialToken("server-1", {
      storage,
      fetchFn: async (input, init) => {
        calls.push(`${String(input)} ${init?.method ?? "GET"}`);
        if (!init?.method || init.method === "GET") {
          return createJsonResponse(TEST_PUBLIC_KEY_RESPONSE);
        }
        return createJsonResponse({
          credentialToken: "token-123",
          expiresAt: "2026-01-02T03:09:05.000Z",
        });
      },
    });

    expect(token).toBe("token-123");
    expect(calls).toEqual([
      "/api/ssh-servers/server-1/public-key GET",
      "/api/ssh-servers/server-1/credentials POST",
    ]);
  });

  test("reuses a cached exchanged token until it expires", async () => {
    const storage = new MemoryStorage();
    const encryptedCredential = await encryptSshServerPassword("secret", TEST_PUBLIC_KEY_RESPONSE);
    saveStoredSshServerCredential("server-1", encryptedCredential, {
      storage,
      now: () => new Date("2026-01-02T03:00:00.000Z"),
    });

    const calls: string[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${String(input)} ${init?.method ?? "GET"}`);
      if (!init?.method || init.method === "GET") {
        return createJsonResponse(TEST_PUBLIC_KEY_RESPONSE);
      }
      return createJsonResponse({
        credentialToken: "token-123",
        expiresAt: "2026-01-02T03:05:00.000Z",
      });
    };

    const firstToken = await getStoredSshCredentialToken("server-1", {
      storage,
      fetchFn,
      now: () => new Date("2026-01-02T03:00:00.000Z"),
    });
    const secondToken = await getStoredSshCredentialToken("server-1", {
      storage,
      fetchFn,
      now: () => new Date("2026-01-02T03:02:00.000Z"),
    });

    expect(firstToken).toBe("token-123");
    expect(secondToken).toBe("token-123");
    expect(calls).toEqual([
      "/api/ssh-servers/server-1/public-key GET",
      "/api/ssh-servers/server-1/credentials POST",
    ]);
  });

  test("clears stale stored credentials when the server key changes", async () => {
    const storage = new MemoryStorage();
    saveStoredSshServerCredential("server-1", {
      algorithm: "RSA-OAEP-256",
      fingerprint: "old-fingerprint",
      version: 1,
      ciphertext: "ciphertext",
    }, { storage });

    const token = await getStoredSshCredentialToken("server-1", {
      storage,
      fetchFn: async () => createJsonResponse({
        ...TEST_PUBLIC_KEY_RESPONSE,
        fingerprint: "new-fingerprint",
      }),
    });

    expect(token).toBeNull();
    expect(getStoredSshServerCredential("server-1", { storage })).toBeNull();
  });

  test("clears invalid stored payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem("ralpher.sshServerCredential.server-1", "{bad json");

    expect(getStoredSshServerCredential("server-1", { storage })).toBeNull();
    expect(storage.getItem("ralpher.sshServerCredential.server-1")).toBeNull();
  });

  test("clears stored credentials after an invalid encrypted credential response", async () => {
    const storage = new MemoryStorage();
    const encryptedCredential = await encryptSshServerPassword("secret", TEST_PUBLIC_KEY_RESPONSE);
    saveStoredSshServerCredential("server-1", encryptedCredential, { storage });

    const token = await getStoredSshCredentialToken("server-1", {
      storage,
      fetchFn: async (_input, init) => {
        if (!init?.method || init.method === "GET") {
          return createJsonResponse(TEST_PUBLIC_KEY_RESPONSE);
        }
        return createJsonResponse({
          code: "invalid_encrypted_credential",
          message: "Credential no longer matches current key",
        }, 400);
      },
    });

    expect(token).toBeNull();
    expect(getStoredSshServerCredential("server-1", { storage })).toBeNull();
  });

  test("can explicitly clear stored credentials", async () => {
    const storage = new MemoryStorage();
    const encryptedCredential = await encryptSshServerPassword("secret", TEST_PUBLIC_KEY_RESPONSE);
    saveStoredSshServerCredential("server-1", encryptedCredential, { storage });

    clearStoredSshServerCredential("server-1", { storage });

    expect(getStoredSshServerCredential("server-1", { storage })).toBeNull();
  });
});
