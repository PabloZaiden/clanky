import { describe, expect, test } from "bun:test";
import { areServerSettingsEqual, findRegisteredSshServer, getServerLabel } from "../../src/types/settings";
import type { SshServer } from "../../src/types";

function createRegisteredSshServer(overrides?: Partial<SshServer["config"]>): SshServer {
  return {
    config: {
      id: "ssh-server-1",
      name: "Production Box",
      address: "10.0.0.42",
      username: "deploy",
      repositoriesBasePath: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...overrides,
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "public-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
    },
  };
}

describe("settings labels", () => {
  test("matches registered SSH servers by address ignoring case and whitespace", () => {
    const sshServer = createRegisteredSshServer({ address: "REMOTE.EXAMPLE " });

    expect(findRegisteredSshServer(" remote.example", [sshServer])).toEqual(sshServer);
  });

  test("uses registered SSH server name in server labels when a match exists", () => {
    const sshServer = createRegisteredSshServer();

    expect(getServerLabel({
      agent: {
        provider: "opencode",
        transport: "ssh",
        hostname: "10.0.0.42",
        port: 22,
        username: "deploy",
      },
    }, [sshServer])).toBe("opencode via ssh (deploy@Production Box:22)");
  });

  test("falls back to raw hostname when no registered SSH server matches", () => {
    expect(getServerLabel({
      agent: {
        provider: "opencode",
        transport: "ssh",
        hostname: "manual.example",
        port: 2222,
      },
    }, [createRegisteredSshServer()])).toBe("opencode via ssh (manual.example:2222)");
  });

  test("keeps stdio labels unchanged", () => {
    expect(getServerLabel({
      agent: {
        provider: "copilot",
        transport: "stdio",
      },
    }, [createRegisteredSshServer()])).toBe("copilot via local stdio");
  });
});

describe("server settings equality", () => {
  test("treats omitted optional SSH fields as equal to undefined persisted fields", () => {
    expect(areServerSettingsEqual(
      {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "example.com",
          port: 22,
        },
      },
      {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "example.com",
          port: 22,
          username: undefined,
          password: undefined,
          identityFile: undefined,
        },
      },
    )).toBe(true);
  });

  test("detects actual server settings changes", () => {
    expect(areServerSettingsEqual(
      {
        agent: {
          provider: "opencode",
          transport: "stdio",
        },
      },
      {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "example.com",
          port: 22,
        },
      },
    )).toBe(false);
  });
});
