import { describe, expect, spyOn, test } from "bun:test";

import { SshCredentialManager } from "../../src/core/ssh-credential-manager";
import { sshServerKeyManager } from "../../src/core/ssh-server-key-manager";

describe("SshCredentialManager", () => {
  test("reuses a short-lived token until it expires", async () => {
    const decryptSpy = spyOn(sshServerKeyManager, "decryptCredential").mockResolvedValue("secret-password");
    const manager = new SshCredentialManager(() => 1_000, 60_000);

    const exchange = await manager.issueToken("server-1", {
      algorithm: "RSA-OAEP-256",
      fingerprint: "fingerprint-1",
      version: 1,
      ciphertext: "ciphertext",
    });

    expect(exchange.credentialToken).toBeString();
    expect(manager.consumeToken("server-1", exchange.credentialToken)).toBe("secret-password");
    expect(manager.consumeToken("server-1", exchange.credentialToken)).toBe("secret-password");

    decryptSpy.mockRestore();
  });

  test("evicts expired tokens before they can be consumed", async () => {
    let now = 1_000;
    const decryptSpy = spyOn(sshServerKeyManager, "decryptCredential").mockResolvedValue("secret-password");
    const manager = new SshCredentialManager(() => now, 10);

    const exchange = await manager.issueToken("server-1", {
      algorithm: "RSA-OAEP-256",
      fingerprint: "fingerprint-1",
      version: 1,
      ciphertext: "ciphertext",
    });
    now = 1_020;

    expect(() => manager.consumeToken("server-1", exchange.credentialToken)).toThrow(
      "SSH credential token is missing or expired",
    );

    decryptSpy.mockRestore();
  });

  test("rejects a token used against the wrong server", async () => {
    const decryptSpy = spyOn(sshServerKeyManager, "decryptCredential").mockResolvedValue("secret-password");
    const manager = new SshCredentialManager(() => 1_000, 60_000);

    const exchange = await manager.issueToken("server-1", {
      algorithm: "RSA-OAEP-256",
      fingerprint: "fingerprint-1",
      version: 1,
      ciphertext: "ciphertext",
    });

    expect(() => manager.consumeToken("server-2", exchange.credentialToken)).toThrow(
      "SSH credential token does not belong to the requested server",
    );

    decryptSpy.mockRestore();
  });
});
