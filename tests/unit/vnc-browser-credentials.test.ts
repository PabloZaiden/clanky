import { describe, expect, test } from "bun:test";

import {
  clearStoredVncPassword,
  getStoredVncCredentials,
  getStoredVncPassword,
  getStoredVncPasswordRecord,
  storeVncCredentials,
  storeVncPassword,
} from "../../src/lib/vnc-browser-credentials";

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

function encodeArrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index++) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function storeLegacyPasswordRecord(storage: MemoryStorage, password: string): Promise<void> {
  const rawKey = storage.getItem("clanky.vncPasswordKey.server-1");
  if (!rawKey) {
    throw new Error("Expected VNC encryption key to exist");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase64ToArrayBuffer(rawKey),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(password),
  );
  storage.setItem("clanky.vncPassword.server-1", JSON.stringify({
    encryptedPassword: {
      algorithm: "AES-GCM-256",
      version: 1,
      iv: encodeArrayBufferToBase64(iv.buffer),
      ciphertext: encodeArrayBufferToBase64(ciphertext),
    },
    storedAt: "2026-05-28T02:00:00.000Z",
  }));
}

describe("vnc-browser-credentials", () => {
  test("stores VNC credentials encrypted without persisting raw values", async () => {
    const storage = new MemoryStorage();

    const record = await storeVncCredentials("server-1", { username: "vnc-user", password: "vnc-secret" }, {
      storage,
      now: () => new Date("2026-05-28T02:00:00.000Z"),
    });

    expect(record.storedAt).toBe("2026-05-28T02:00:00.000Z");
    expect(record.encryptedCredentials.ciphertext).not.toBe("vnc-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("vnc-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("vnc-user");
    expect(await getStoredVncCredentials("server-1", { storage })).toEqual({
      username: "vnc-user",
      password: "vnc-secret",
    });
  });

  test("updates the stored VNC credentials when saving a new value", async () => {
    const storage = new MemoryStorage();

    await storeVncCredentials("server-1", { username: "old-user", password: "old-secret" }, { storage });
    await storeVncCredentials("server-1", { username: "new-user", password: "new-secret" }, { storage });

    expect(await getStoredVncCredentials("server-1", { storage })).toEqual({
      username: "new-user",
      password: "new-secret",
    });
    expect(await getStoredVncPassword("server-1", { storage })).toBe("new-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("new-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("new-user");
  });

  test("preserves an empty VNC username as a valid stored value", async () => {
    const storage = new MemoryStorage();

    await storeVncCredentials("server-1", { username: "", password: "vnc-secret" }, { storage });

    expect(await getStoredVncCredentials("server-1", { storage })).toEqual({
      username: "",
      password: "vnc-secret",
    });
  });

  test("reads legacy VNC password-only records without inventing a username", async () => {
    const storage = new MemoryStorage();

    await storeVncPassword("server-1", "temporary-secret", { storage });
    await storeLegacyPasswordRecord(storage, "legacy-secret");

    expect(await getStoredVncCredentials("server-1", { storage })).toEqual({
      password: "legacy-secret",
    });
  });

  test("clears invalid and undecryptable VNC password payloads", async () => {
    const storage = new MemoryStorage();

    storage.setItem("clanky.vncPassword.server-1", "{bad json");
    expect(getStoredVncPasswordRecord("server-1", { storage })).toBeNull();
    expect(storage.getItem("clanky.vncPassword.server-1")).toBeNull();

    await storeVncPassword("server-1", "vnc-secret", { storage });
    storage.setItem("clanky.vncPasswordKey.server-1", btoa("not-a-valid-aes-key"));

    expect(await getStoredVncPassword("server-1", { storage })).toBeNull();
    expect(storage.getItem("clanky.vncPassword.server-1")).toBeNull();
    expect(storage.getItem("clanky.vncPasswordKey.server-1")).toBeNull();
  });

  test("can explicitly clear a stored VNC password", async () => {
    const storage = new MemoryStorage();

    await storeVncPassword("server-1", "vnc-secret", { storage });
    clearStoredVncPassword("server-1", { storage });

    expect(await getStoredVncPassword("server-1", { storage })).toBeNull();
  });
});
