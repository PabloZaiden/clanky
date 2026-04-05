import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { constants, publicEncrypt } from "node:crypto";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDataDirectories, closeDatabase } from "../../src/persistence/database";
import { sshServerManager } from "../../src/core/ssh-server-manager";
import { sshServerKeyManager } from "../../src/core/ssh-server-key-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";

class SshServerTestExecutor extends TestCommandExecutor {
  public deleteCommands: string[] = [];
  constructor(
    private readonly options: {
      connectionAvailable?: boolean;
      bashAvailable?: boolean;
      dtachAvailable?: boolean;
      devboxAvailable?: boolean;
    } = {},
  ) {
    super();
  }

  override async exec(command: string, args: string[], options?: Parameters<TestCommandExecutor["exec"]>[2]) {
    if (command === "true") {
      if (this.options.connectionAvailable === false) {
        return {
          success: false,
          stdout: "",
          stderr: "ssh connection failed",
          exitCode: 255,
        };
      }
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v bash")) {
      const available = this.options.bashAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/bin/bash\n" : "",
        stderr: available ? "" : "bash missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v devbox")) {
      const available = this.options.devboxAvailable ?? true;
      return {
        success: available,
        stdout: available ? "/usr/bin/devbox\n" : "",
        stderr: available ? "" : "devbox missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "sh" && args[0] === "-c" && args[1]?.includes("command -v dtach")) {
      const available = this.options.dtachAvailable ?? true;
      return {
        success: available,
        stdout: available ? "dtach - version 0.9\n" : "",
        stderr: available ? "" : "dtach missing",
        exitCode: available ? 0 : 127,
      };
    }
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes("command -v dtach")) {
      return {
        success: true,
        stdout: "dtach - version 0.9\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (command === "bash" && args[0] === "-lc" && args[1]?.includes(".dtach.sock")) {
      this.deleteCommands.push(args[1]);
      return {
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    }
    return await super.exec(command, args, options);
  }
}

class MissingDtachExecutor extends SshServerTestExecutor {
  constructor() {
    super({ dtachAvailable: false });
  }
}

let dataDir: string;
let executor: SshServerTestExecutor;

async function issueCredentialToken(serverId: string, password = "secret"): Promise<string> {
  const publicKey = await sshServerKeyManager.ensurePublicKey(serverId);
  const ciphertext = publicEncrypt({
    key: publicKey.publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(password, "utf8")).toString("base64");
  const exchange = await (await import("../../src/core/ssh-credential-manager")).sshCredentialManager.issueToken(serverId, {
    algorithm: publicKey.algorithm,
    fingerprint: publicKey.fingerprint,
    version: publicKey.version,
    ciphertext,
  });
  return exchange.credentialToken;
}

describe("SshServerManager", () => {
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-ssh-server-manager-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;
    await ensureDataDirectories();
    executor = new SshServerTestExecutor();
    sshServerManager.setExecutorFactoryForTesting(() => executor);
  });

  afterEach(async () => {
    sshServerManager.setExecutorFactoryForTesting(null);
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  test("creates, lists, updates, and deletes standalone SSH servers", async () => {
    const server = await sshServerManager.createServer({
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
    });

    expect(server.publicKey.publicKey).toContain("BEGIN PUBLIC KEY");
    expect((await sshServerManager.listServers())).toHaveLength(1);

    const updated = await sshServerManager.updateServer(server.config.id, {
      name: "Renamed host",
    });
    expect(updated.config.name).toBe("Renamed host");

    expect(await sshServerManager.deleteServer(server.config.id)).toBe(true);
    expect(await sshServerManager.getServer(server.config.id)).toBeNull();
  });

  test("creates standalone SSH sessions without requiring a credential token up front", async () => {
    const server = await sshServerManager.createServer({
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
    });

    const session = await sshServerManager.createSession(server.config.id, {
      name: "Deploy shell",
    });
    expect(session.config.name).toBe("Deploy shell");
    expect(session.config.connectionMode).toBe("dtach");

    const deleteToken = await issueCredentialToken(server.config.id);
    expect(await sshServerManager.deleteSession(session.config.id, {
      credentialToken: deleteToken,
    })).toBe(true);
    expect(executor.deleteCommands.some((command) => command.includes(session.config.remoteSessionName))).toBe(true);
  });

  test("still creates standalone sessions when dtach is unavailable at creation time", async () => {
    sshServerManager.setExecutorFactoryForTesting(() => new MissingDtachExecutor());
    const server = await sshServerManager.createServer({
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
    });

    const session = await sshServerManager.createSession(server.config.id, {});
    expect(session.config.connectionMode).toBe("dtach");
  });

  test("reports all configured prerequisites for a provisioning-enabled standalone SSH server", async () => {
    const server = await sshServerManager.createServer({
      name: "Provision Host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: "/workspaces",
    });

    const report = await sshServerManager.checkPrerequisites(server.config.id);
    expect(report.summary.status).toBe("ready");
    expect(report.summary.availableCount).toBe(4);
    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ["ssh_connection", "available"],
      ["bash", "available"],
      ["dtach", "available"],
      ["devbox", "available"],
    ]);
  });

  test("marks devbox as not applicable when provisioning is not configured", async () => {
    const server = await sshServerManager.createServer({
      name: "Terminal Host",
      address: "ssh.example.com",
      username: "deploy",
    });

    const report = await sshServerManager.checkPrerequisites(server.config.id);
    const devboxCheck = report.checks.find((check) => check.id === "devbox");
    expect(devboxCheck?.status).toBe("not_applicable");
    expect(report.summary.notApplicableCount).toBe(1);
  });

  test("reports missing dtach and failed connectivity explicitly", async () => {
    sshServerManager.setExecutorFactoryForTesting(() => new SshServerTestExecutor({
      dtachAvailable: false,
    }));
    const server = await sshServerManager.createServer({
      name: "Missing Dtach Host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: "/workspaces",
    });

    const report = await sshServerManager.checkPrerequisites(server.config.id);
    expect(report.summary.status).toBe("missing_requirements");
    expect(report.checks.find((check) => check.id === "dtach")?.status).toBe("missing");
    expect(report.checks.find((check) => check.id === "dtach")?.installHint).toContain("Install dtach");

    sshServerManager.setExecutorFactoryForTesting(() => new SshServerTestExecutor({
      connectionAvailable: false,
    }));
    const connectionReport = await sshServerManager.checkPrerequisites(server.config.id);
    expect(connectionReport.summary.status).toBe("connection_failed");
    expect(connectionReport.checks.find((check) => check.id === "ssh_connection")?.status).toBe("missing");
    expect(connectionReport.checks.find((check) => check.id === "bash")?.status).toBe("unknown");
  });
});
