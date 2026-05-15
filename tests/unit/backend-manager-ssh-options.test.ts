import { describe, expect, test } from "bun:test";

import { buildConnectionConfig } from "../../src/core/backend-manager";

describe("buildConnectionConfig SSH command options", () => {
  function getSshOptionValue(args: string[], optionName: string): string | undefined {
    const prefix = `${optionName}=`;
    return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  }

  test("uses sshpass with non-interactive ssh options when password is set", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 2222,
          username: "alice",
          password: "secret",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];

    expect(config.command).toBe("sshpass");
    expect(args.slice(0, 2)).toEqual(["-e", "ssh"]);
    expect(args).not.toContain("secret");
    expect(config.env?.["SSHPASS"]).toBe("secret");
    expect(args).toContain("ssh");
    expect(args).toContain("NumberOfPasswordPrompts=1");
    expect(args).toContain("PreferredAuthentications=password,keyboard-interactive");
    expect(args).not.toContain("ControlMaster=auto");
    expect(args).not.toContain("ControlPersist=60s");
    expect(getSshOptionValue(args, "ControlPath")).toBeUndefined();
    expect(args).toContain("ConnectTimeout=10");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
    expect(args).toContain("alice@remote.example.com");
    expect(args[args.length - 1]).toContain("sh -lc");
    expect(args[args.length - 1]).toContain('exec "$shell_path" -ilc');
    expect(args[args.length - 1]).toContain("copilot");
    expect(args[args.length - 1]).toContain("--yolo");
    expect(args[args.length - 1]).toContain("--acp");
  });

  test("uses batch mode with non-interactive ssh options when password is not set", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 22,
          username: "alice",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];

    expect(config.command).toBe("ssh");
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPersist=60s");
    expect(getSshOptionValue(args, "ControlPath")).toMatch(/^~\/\.ssh\/ralpher-cm-v1-[a-f0-9]{32}$/);
    expect(args).toContain("ConnectTimeout=10");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
    expect(args[args.length - 1]).toContain("sh -lc");
    expect(args[args.length - 1]).toContain('exec "$shell_path" -ilc');
    expect(args[args.length - 1]).toContain("copilot");
    expect(args[args.length - 1]).toContain("--yolo");
    expect(args[args.length - 1]).toContain("--acp");
  });

  test("uses an explicit identity file when one is configured", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 22,
          username: "alice",
          identityFile: "/tmp/test-key",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];

    expect(config.command).toBe("ssh");
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPersist=60s");
    expect(args).toContain("IdentityAgent=none");
    expect(args).toContain("IdentitiesOnly=yes");
    const identityFileIndex = args.indexOf("-i");
    expect(identityFileIndex).toBeGreaterThanOrEqual(0);
    expect(args[identityFileIndex + 1]).toBe("/tmp/test-key");
  });

  test("scopes SSH ControlPath by workspace directory", () => {
    const firstConfig = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 22,
          username: "alice",
        },
      },
      "/workspaces/project",
    );
    const secondConfig = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 22,
          username: "alice",
        },
      },
      "/workspaces/other-project",
    );

    expect(getSshOptionValue(firstConfig.args ?? [], "ControlPath")).not.toBe(
      getSshOptionValue(secondConfig.args ?? [], "ControlPath"),
    );
  });
});

describe("buildConnectionConfig does not embed model in CLI args", () => {
  test("copilot stdio does not include --model flag", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "stdio",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];
    expect(config.command).toBe("copilot");
    expect(args).toContain("--yolo");
    expect(args).toContain("--acp");
    expect(args).not.toContain("--model");
  });

  test("copilot SSH remote command does not include --model flag", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "remote.example.com",
          port: 22,
          username: "alice",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];
    const remoteCommand = args[args.length - 1] ?? "";
    expect(remoteCommand).toContain("copilot --yolo --acp");
    expect(remoteCommand).not.toContain("--model");
  });

  test("opencode stdio does not include --model flag", () => {
    const config = buildConnectionConfig(
      {
        agent: {
          provider: "opencode",
          transport: "stdio",
        },
      },
      "/workspaces/project",
    );
    const args = config.args ?? [];
    expect(config.command).toBe("opencode");
    expect(args).not.toContain("--model");
  });
});
