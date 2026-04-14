import { describe, expect, test } from "bun:test";

import {
  CreateSshServerRequestSchema,
  UpdateSshServerRequestSchema,
  SshCredentialExchangeRequestSchema,
} from "../../src/types/schemas/ssh-server";

describe("CreateSshServerRequestSchema", () => {
  test("accepts trimmed standalone SSH server metadata", () => {
    const result = CreateSshServerRequestSchema.safeParse({
      name: "  Shared staging host  ",
      address: "  ssh.example.com  ",
      username: "  deploy  ",
      repositoriesBasePath: null,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data).toEqual({
      name: "Shared staging host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: null,
    });
  });

  test("rejects blank server metadata", () => {
    expect(CreateSshServerRequestSchema.safeParse({
      name: "  ",
      address: "ssh.example.com",
      username: "deploy",
    }).success).toBe(false);
  });
});

describe("UpdateSshServerRequestSchema", () => {
  test("requires at least one updatable field", () => {
    expect(UpdateSshServerRequestSchema.safeParse({}).success).toBe(false);
  });

  test("accepts partial updates", () => {
    const result = UpdateSshServerRequestSchema.safeParse({
      address: "  host.internal  ",
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.address).toBe("host.internal");
  });
});

describe("SshCredentialExchangeRequestSchema", () => {
  test("accepts encrypted credential envelopes", () => {
    const result = SshCredentialExchangeRequestSchema.safeParse({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fingerprint-1",
        version: 3,
        ciphertext: "base64-ciphertext",
      },
    });

    expect(result.success).toBe(true);
  });

  test("rejects invalid encrypted credential versions", () => {
    expect(SshCredentialExchangeRequestSchema.safeParse({
      encryptedCredential: {
        algorithm: "RSA-OAEP-256",
        fingerprint: "fingerprint-1",
        version: 0,
        ciphertext: "base64-ciphertext",
      },
    }).success).toBe(false);
  });
});
