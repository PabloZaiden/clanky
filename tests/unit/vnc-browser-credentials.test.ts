import { describe, expect, test } from "bun:test";

import {
  clearStoredVncPassword,
  getStoredVncPassword,
  getStoredVncPasswordRecord,
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

describe("vnc-browser-credentials", () => {
  test("stores a VNC password encrypted without persisting the raw password", async () => {
    const storage = new MemoryStorage();

    const record = await storeVncPassword("server-1", "vnc-secret", {
      storage,
      now: () => new Date("2026-05-28T02:00:00.000Z"),
    });

    expect(record.storedAt).toBe("2026-05-28T02:00:00.000Z");
    expect(record.encryptedPassword.ciphertext).not.toBe("vnc-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("vnc-secret");
    expect(await getStoredVncPassword("server-1", { storage })).toBe("vnc-secret");
  });

  test("updates the stored VNC password when saving a new value", async () => {
    const storage = new MemoryStorage();

    await storeVncPassword("server-1", "old-secret", { storage });
    await storeVncPassword("server-1", "new-secret", { storage });

    expect(await getStoredVncPassword("server-1", { storage })).toBe("new-secret");
    expect(storage.getItem("clanky.vncPassword.server-1")).not.toContain("new-secret");
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
