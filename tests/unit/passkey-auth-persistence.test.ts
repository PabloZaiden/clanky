import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bumpPasskeyAuthVersion,
  deleteAllPasskeys,
  getOrCreatePasskeyAuthSecret,
  getPasskeyAuthVersion,
  getPasskeyByCredentialId,
  hasRegisteredPasskeys,
  listPasskeys,
  savePasskey,
  updatePasskeyUsage,
} from "../../src/persistence/passkey-auth";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("passkey auth persistence", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("stores and retrieves passkeys", async () => {
    const publicKey = new Uint8Array([1, 2, 3, 4]);

    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey,
      counter: 7,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal"],
    });

    expect(await hasRegisteredPasskeys()).toBe(true);

    const saved = await getPasskeyByCredentialId("credential-1");
    expect(saved).toBeDefined();
    expect(saved?.name).toBe("Primary passkey");
    expect(Array.from(saved?.publicKey ?? [])).toEqual([1, 2, 3, 4]);

    const all = await listPasskeys();
    expect(all).toHaveLength(1);
    expect(all[0]?.credentialId).toBe("credential-1");
  });

  test("updates passkey usage metadata", async () => {
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 1,
      deviceType: "multiDevice",
      backedUp: true,
      transports: ["hybrid"],
    });

    await updatePasskeyUsage("credential-1", 9, ["internal", "hybrid"]);

    const saved = await getPasskeyByCredentialId("credential-1");
    expect(saved?.counter).toBe(9);
    expect(saved?.transports).toEqual(["internal", "hybrid"]);
    expect(saved?.lastUsedAt).toBeDefined();
  });

  test("creates a stable auth secret and increments auth version", async () => {
    const secret = await getOrCreatePasskeyAuthSecret();
    const repeated = await getOrCreatePasskeyAuthSecret();

    expect(secret).toBe(repeated);
    expect(secret.length).toBeGreaterThan(20);

    expect(await getPasskeyAuthVersion()).toBe(0);
    expect(await bumpPasskeyAuthVersion()).toBe(1);
    expect(await bumpPasskeyAuthVersion()).toBe(2);
    expect(await getPasskeyAuthVersion()).toBe(2);
  });

  test("deletes all stored passkeys", async () => {
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 1,
      deviceType: "singleDevice",
      backedUp: false,
    });

    await deleteAllPasskeys();

    expect(await hasRegisteredPasskeys()).toBe(false);
    expect(await listPasskeys()).toEqual([]);
  });
});
