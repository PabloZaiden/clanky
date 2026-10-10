import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { commitAndPushFile, createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import { readProcessDiagnostics } from "./support/process";
import {
  installExternalDevboxProvider,
  installFailingExternalProvider,
} from "./support/provider";
import {
  restartEphemeralSshServer,
  startEphemeralSshServer,
  stopEphemeralSshServer,
  type ManagedSshServer,
} from "./support/ssh-server";

interface SshServerRecord {
  config: {
    id: string;
    address: string;
    name: string;
    port: number;
    username: string;
  };
  publicKey: SshPublicKey;
}

interface SshPublicKey {
  algorithm: "RSA-OAEP-256";
  fingerprint: string;
  publicKey: string;
  version: number;
}

interface CredentialExchange {
  credentialToken: string;
  expiresAt: string;
}

interface Workspace {
  directory: string;
  id: string;
}

interface Model {
  connected: boolean;
  modelID: string;
  providerID: string;
}

interface Chat {
  config: {
    id: string;
  };
  state: {
    status: string;
  };
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      content: string;
      role: string;
    }>;
  };
}

interface ApiKeyResponse {
  key: {
    id: string;
  };
  token: string;
}

interface TerminalSession {
  config: {
    id: string;
  };
}

interface TerminalFrame {
  data?: string;
  transport?: string;
  type?: string;
  [key: string]: unknown;
}

interface ProvisioningSnapshot {
  job: {
    config: {
      id: string;
      name: string;
    };
    state: {
      currentStep?: string;
      error?: {
        code: string;
        step?: string;
      };
      resolvedDirectory?: string;
      status: string;
      targetDirectory?: string;
      workspaceAction?: string;
      workspaceId?: string;
    };
  };
  logs: Array<{
    source: string;
    step?: string;
    text: string;
  }>;
  workspace?: Workspace;
}

type RuntimeWebSocketConstructor = new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

let application: E2EApplication | undefined;
let sshServer: ManagedSshServer | undefined;

afterEach(async () => {
  await application?.stop();
  if (sshServer) {
    await stopEphemeralSshServer(sshServer);
    sshServer = undefined;
  }
  await application?.cleanup();
  application = undefined;
});

function decodePublicKey(publicKey: string): ArrayBuffer {
  return Uint8Array.from(Buffer.from(
    publicKey
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")
      .replace(/\s+/g, ""),
    "base64",
  )).buffer;
}

async function encryptSshPassword(
  password: string,
  publicKey: SshPublicKey,
): Promise<Record<string, unknown>> {
  const importedKey = await crypto.subtle.importKey(
    "spki",
    decodePublicKey(publicKey.publicKey),
    {
      name: "RSA-OAEP",
      hash: "SHA-256",
    },
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    importedKey,
    new TextEncoder().encode(password),
  );
  return {
    algorithm: publicKey.algorithm,
    fingerprint: publicKey.fingerprint,
    version: publicKey.version,
    ciphertext: Buffer.from(ciphertext).toString("base64"),
  };
}

async function waitForChatIdle(
  app: E2EApplication,
  chatId: string,
): Promise<Chat> {
  return await pollUntil(
    async () => (await app.json<Chat>(`/api/chats/${chatId}`)).data,
    (chat) => chat.state.status === "idle" || chat.state.status === "failed",
    {
      description: `SSH chat ${chatId} to settle`,
      timeoutMs: 10_000,
      formatLastObserved: (chat) => JSON.stringify(chat.state),
    },
  );
}

async function waitForProvisioning(
  app: E2EApplication,
  jobId: string,
  predicate: (snapshot: ProvisioningSnapshot) => boolean,
  description: string,
): Promise<ProvisioningSnapshot> {
  return await pollUntil(
    async () => (
      await app.json<ProvisioningSnapshot>(`/api/provisioning-jobs/${jobId}`)
    ).data,
    predicate,
    {
      description,
      timeoutMs: 10_000,
      formatLastObserved: (snapshot) => JSON.stringify({
        status: snapshot.job.state.status,
        step: snapshot.job.state.currentStep,
        error: snapshot.job.state.error,
      }),
    },
  );
}

function provisioningRequest(options: {
  basePath: string;
  mode: "provision" | "restart";
  name: string;
  provider: "claude" | "copilot";
  repoUrl?: string;
  serverId: string;
  targetDirectory?: string;
  workspaceId?: string;
}): Record<string, unknown> {
  return {
    name: options.name,
    executionHost: {
      kind: "ssh",
      serverId: options.serverId,
    },
    transport: "ssh",
    repoUrl: options.repoUrl ?? "",
    basePath: options.basePath,
    devcontainerSubpath: null,
    devboxTemplate: null,
    githubUser: null,
    provider: options.provider,
    adapter: "acp",
    credentialToken: null,
    mode: options.mode,
    createNewRepository: false,
    targetDirectory: options.targetDirectory ?? null,
    workspaceId: options.workspaceId ?? null,
  };
}

function createAuthenticatedSocket(
  app: E2EApplication,
  path: string,
  apiKey: string,
): WebSocket {
  const url = new URL(path, app.baseUrl);
  url.protocol = "ws:";
  const RuntimeWebSocket = WebSocket as unknown as RuntimeWebSocketConstructor;
  return new RuntimeWebSocket(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Origin: app.baseUrl,
    },
  });
}

async function exerciseSshTerminal(
  app: E2EApplication,
  workspace: Workspace,
  apiKey: string,
): Promise<void> {
  const session = (await app.json<TerminalSession>(
    "/api/terminal-sessions",
    {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "SSH E2E shell",
        connectionMode: "direct",
        useTmux: false,
      }),
    },
    201,
  )).data;
  const frames: TerminalFrame[] = [];
  let output = "";
  const socket = createAuthenticatedSocket(
    app,
    `/api/terminal?terminalSessionId=${encodeURIComponent(session.config.id)}`,
    apiKey,
  );
  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string"
      ? event.data
      : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    const frame = JSON.parse(raw) as TerminalFrame;
    frames.push(frame);
    if (frame.type === "terminal.output" && typeof frame.data === "string") {
      output += frame.data;
    }
  });

  try {
    const connected = await pollUntil(
      () => frames.find((frame) => frame.type === "terminal.connected"),
      (frame) => frame !== undefined,
      {
        description: "SSH terminal websocket connection",
        timeoutMs: 5_000,
      },
    );
    expect(connected?.transport).toBe("ssh");
    expect(connected?.["runtimeConnectionMode"]).toBe("direct");
    socket.send(JSON.stringify({
      type: "terminal.input",
      data: "printf 'SSH_TERMINAL_E2E:%s\\n' \"$PWD\"\n",
    }));
    expect(await pollUntil(
      () => output,
      (value) => value.includes("SSH_TERMINAL_E2E:"),
      {
        description: "SSH terminal command output",
        timeoutMs: 5_000,
      },
    )).toContain(workspace.directory);
    socket.send(JSON.stringify({ type: "terminal.input", data: "exit\n" }));
    await pollUntil(
      () => frames.some((frame) => frame.type === "terminal.closed"),
      Boolean,
      {
        description: "SSH terminal shell exit",
        timeoutMs: 5_000,
      },
    );
  } finally {
    socket.close();
  }

  await app.json(
    `/api/terminal-sessions/${encodeURIComponent(session.config.id)}`,
    { method: "DELETE", apiKey },
  );
}

test("compiled app crosses real SSH execution, files, Git, terminal, and ACP boundaries", async () => {
  application = await E2EApplication.create();
  await installFailingExternalProvider(
    application.providerBinDirectory,
    "claude-agent-acp",
  );
  const sshOptions = {
    clientHomeDirectory: application.homeDirectory,
    providerBinDirectory: application.providerBinDirectory,
    runDirectory: application.runDirectory,
  };
  sshServer = await startEphemeralSshServer(sshOptions);
  await installExternalDevboxProvider(
    application.providerBinDirectory,
    sshServer.port,
  );

  try {
    await application.start({
      env: {
        SSH_AUTH_SOCK: sshServer.agentSocket,
      },
    });
    const git = await createGitFixture(application.runDirectory);
    const registeredServer = (await application.json<SshServerRecord>(
      "/api/ssh-servers",
      {
        method: "POST",
        body: JSON.stringify({
          name: "Ephemeral SSH",
          address: "127.0.0.1",
          port: sshServer.port,
          username: sshServer.username,
          repositoriesBasePath: application.runDirectory,
        }),
      },
      201,
    )).data;
    const serverId = registeredServer.config.id;
    expect(registeredServer.config).toMatchObject({
      address: "127.0.0.1",
      name: "Ephemeral SSH",
      port: sshServer.port,
      username: sshServer.username,
    });
    expect(
      (await application.json<SshServerRecord[]>("/api/ssh-servers")).data
        .map((server) => server.config.id),
    ).toContain(serverId);
    const apiKey = (await application.json<ApiKeyResponse>(
      "/api/api-keys",
      {
        method: "POST",
        body: JSON.stringify({
          name: "ssh-e2e",
          scopes: ["*"],
        }),
      },
    )).data;

    const publicKey = (await application.json<SshPublicKey>(
      `/api/ssh-servers/${serverId}/public-key`,
    )).data;
    expect(publicKey.algorithm).toBe("RSA-OAEP-256");
    const credential = (await application.json<CredentialExchange>(
      `/api/ssh-servers/${serverId}/credentials`,
      {
        method: "POST",
        body: JSON.stringify({
          encryptedCredential: await encryptSshPassword(
            "deliberately-invalid-password",
            publicKey,
          ),
        }),
      },
      201,
    )).data;
    expect(credential.credentialToken.length).toBeGreaterThan(20);
    expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.now());

    const rejectedCredentialExecution = await application.request(
      `/api/execution-hosts/ssh/${serverId}/exec`,
      {
        method: "POST",
        headers: {
          "x-clanky-ssh-credential-token": credential.credentialToken,
        },
        body: JSON.stringify({
          command: "printf",
          args: ["should-not-run"],
          cwd: git.repositoryDirectory,
          timeoutMs: 5_000,
        }),
      },
    );
    expect(rejectedCredentialExecution.status).toBe(400);
    expect(await rejectedCredentialExecution.json()).toMatchObject({
      error: "execution_host_exec_cwd_not_found",
    });

    const serverExec = await application.cli([
      "server",
      "exec",
      serverId,
      "--cwd",
      git.repositoryDirectory,
      "--",
      "sh",
      "-lc",
      "printf 'SSH_EXEC:%s:%s' \"$PWD\" \"$(git rev-parse --is-inside-work-tree)\"",
    ], { apiKey: apiKey.token });
    expect(serverExec.stdout).toBe(`SSH_EXEC:${git.repositoryDirectory}:true`);

    const workspace = (await application.json<Workspace>(
      "/api/workspaces",
      {
        method: "POST",
        body: JSON.stringify({
          name: "SSH workspace",
          directory: git.repositoryDirectory,
          executionHost: {
            kind: "ssh",
            serverId,
          },
          serverSettings: {
            agent: {
              adapter: "acp",
              provider: "copilot",
            },
          },
        }),
      },
      201,
    )).data;
    const branches = (await application.json<{
      branches: Array<{ name: string }>;
      currentBranch: string;
    }>(`/api/git/branches?workspaceId=${workspace.id}`)).data;
    expect(branches.currentBranch).toBe(git.branch);
    expect(branches.branches.map((branch) => branch.name)).toContain(git.branch);

    const sourcePath = join(application.runDirectory, "ssh-upload-source.txt");
    const downloadPath = join(application.runDirectory, "ssh-download.txt");
    await Bun.write(sourcePath, "real SSH file transfer\n");
    expect((await application.cli([
      "workspace",
      "upload",
      workspace.id,
      sourcePath,
      "--remote-path",
      "ssh-transfer.txt",
    ], { apiKey: apiKey.token })).exitCode).toBe(0);
    expect((await application.cli([
      "workspace",
      "download",
      workspace.id,
      "ssh-transfer.txt",
      "--output",
      downloadPath,
      "--force",
    ], { apiKey: apiKey.token })).exitCode).toBe(0);
    expect(await Bun.file(downloadPath).text()).toBe("real SSH file transfer\n");

    const models = (await application.json<Model[]>(
      `/api/models?workspaceId=${workspace.id}`,
    )).data;
    const model = models.find(
      (candidate) => candidate.providerID === "copilot"
        && candidate.connected,
    );
    expect(model).toMatchObject({
      connected: true,
      providerID: "copilot",
      modelID: "mock-model",
    });

    const chat = (await application.json<Chat>(
      "/api/chats",
      {
        method: "POST",
        body: JSON.stringify({
          name: "SSH ACP chat",
          workspaceId: workspace.id,
          model: {
            providerID: "copilot",
            modelID: model!.modelID,
            variant: "",
          },
          useWorktree: false,
          baseBranch: git.branch,
          autoApprovePermissions: true,
        }),
      },
      201,
    )).data;
    await application.json(
      `/api/chats/${chat.config.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          message: "Run the external provider over SSH [provider-write]",
          attachments: [],
        }),
      },
    );
    expect((await waitForChatIdle(application, chat.config.id)).state.status).toBe("idle");
    const snapshot = (await application.json<ChatSnapshot>(
      `/api/chats/${chat.config.id}/snapshot?full=1`,
    )).data;
    expect(snapshot.transcript.messages).toContainEqual(expect.objectContaining({
      role: "user",
      content: "Run the external provider over SSH [provider-write]",
    }));
    const providerDownload = join(application.runDirectory, "provider-download.txt");
    await application.cli([
      "workspace",
      "download",
      workspace.id,
      "e2e-provider-change.txt",
      "--output",
      providerDownload,
      "--force",
    ], { apiKey: apiKey.token });
    expect(await Bun.file(providerDownload).text()).toBe(
      "created by the external ACP provider\n",
    );

    await exerciseSshTerminal(application, workspace, apiKey.token);

    const provisioningBase = join(application.runDirectory, "provisioned");
    const provisioningStarted = (await application.json<ProvisioningSnapshot>(
      "/api/provisioning-jobs",
      {
        method: "POST",
        body: JSON.stringify(provisioningRequest({
          basePath: provisioningBase,
          mode: "provision",
          name: "Provisioned SSH workspace",
          provider: "copilot",
          repoUrl: git.remoteDirectory,
          serverId,
        })),
      },
      201,
    )).data;
    const provisioningCompleted = await waitForProvisioning(
      application,
      provisioningStarted.job.config.id,
      (candidate) => ["completed", "failed"].includes(candidate.job.state.status),
      "successful SSH provisioning job",
    );
    expect(provisioningCompleted.job.state).toMatchObject({
      status: "completed",
      currentStep: "workspace_ready",
      workspaceAction: "created",
    });
    expect(provisioningCompleted.workspace?.id).toBe(
      provisioningCompleted.job.state.workspaceId,
    );
    expect(provisioningCompleted.job.state.targetDirectory).toBe(
      join(provisioningBase, "remote"),
    );
    const provisionedWorkspaceId = provisioningCompleted.job.state.workspaceId!;
    expect(
      (await application.json<Workspace>(
        `/api/workspaces/${provisionedWorkspaceId}`,
      )).data.directory,
    ).toBe(provisioningCompleted.job.state.resolvedDirectory!);
    expect(
      (await application.json<Model[]>(
        `/api/models?workspaceId=${provisionedWorkspaceId}`,
      )).data.some(
        (candidate) => candidate.providerID === "copilot" && candidate.connected,
      ),
    ).toBe(true);

    const restartJob = (await application.json<ProvisioningSnapshot>(
      "/api/provisioning-jobs",
      {
        method: "POST",
        body: JSON.stringify(provisioningRequest({
          basePath: "",
          mode: "restart",
          name: "Restart provisioned SSH workspace",
          provider: "copilot",
          serverId,
          targetDirectory: provisioningCompleted.job.state.targetDirectory,
          workspaceId: provisionedWorkspaceId,
        })),
      },
      201,
    )).data;
    const restartCompleted = await waitForProvisioning(
      application,
      restartJob.job.config.id,
      (candidate) => ["completed", "failed"].includes(candidate.job.state.status),
      "SSH workspace restart provisioning job",
    );
    expect(restartCompleted.job.state).toMatchObject({
      status: "completed",
      currentStep: "workspace_ready",
      workspaceAction: "reused",
      workspaceId: provisionedWorkspaceId,
    });

    const failureGit = await createGitFixture(
      join(application.runDirectory, "provision-failure-source"),
    );
    const failedJob = (await application.json<ProvisioningSnapshot>(
      "/api/provisioning-jobs",
      {
        method: "POST",
        body: JSON.stringify(provisioningRequest({
          basePath: join(application.runDirectory, "provision-failure"),
          mode: "provision",
          name: "Failing SSH workspace",
          provider: "claude",
          repoUrl: failureGit.remoteDirectory,
          serverId,
        })),
      },
      201,
    )).data;
    const provisioningFailed = await waitForProvisioning(
      application,
      failedJob.job.config.id,
      (candidate) => candidate.job.state.status === "failed",
      "failed SSH provisioning cleanup",
    );
    expect(provisioningFailed.job.state.error).toMatchObject({
      code: "connection_test_failed",
      step: "test_connection",
    });
    expect(provisioningFailed.job.state.workspaceId).toBeUndefined();
    expect(provisioningFailed.workspace).toBeUndefined();
    expect(
      (await application.json<Array<{ name: string }>>("/api/workspaces")).data
        .some((candidate) => candidate.name === "Failing SSH workspace"),
    ).toBe(false);

    const cancellationGit = await createGitFixture(
      join(application.runDirectory, "provision-cancel-source"),
    );
    await commitAndPushFile(
      cancellationGit,
      ".e2e-devbox-slow",
      "wait for cancellation\n",
    );
    const cancellationJob = (await application.json<ProvisioningSnapshot>(
      "/api/provisioning-jobs",
      {
        method: "POST",
        body: JSON.stringify(provisioningRequest({
          basePath: join(application.runDirectory, "provision-cancel"),
          mode: "provision",
          name: "Cancelled SSH workspace",
          provider: "copilot",
          repoUrl: cancellationGit.remoteDirectory,
          serverId,
        })),
      },
      201,
    )).data;
    await waitForProvisioning(
      application,
      cancellationJob.job.config.id,
      (candidate) => candidate.job.state.status === "running"
        && candidate.job.state.currentStep === "devbox_up",
      "cancellable SSH provisioning command",
    );
    await application.json(
      `/api/provisioning-jobs/${cancellationJob.job.config.id}`,
      { method: "DELETE" },
    );
    const provisioningCancelled = await waitForProvisioning(
      application,
      cancellationJob.job.config.id,
      (candidate) => candidate.job.state.status === "cancelled",
      "cancelled SSH provisioning cleanup",
    );
    expect(provisioningCancelled.job.state.error).toMatchObject({
      code: "cancelled",
      step: "devbox_up",
    });
    expect(provisioningCancelled.job.state.workspaceId).toBeUndefined();
    const provisioningLogs = (await application.json<{
      logs: ProvisioningSnapshot["logs"];
    }>(`/api/provisioning-jobs/${cancellationJob.job.config.id}/logs`)).data.logs;
    expect(provisioningLogs.some(
      (entry) => entry.source === "system"
        && entry.text.includes("Cancellation requested"),
    )).toBe(true);

    await restartEphemeralSshServer(sshServer, sshOptions);
    expect((await application.cli([
      "server",
      "exec",
      serverId,
      "--",
      "printf",
      "SSH_RECONNECTED",
    ], { apiKey: apiKey.token })).stdout).toBe("SSH_RECONNECTED");

    await application.restart({
      env: {
        SSH_AUTH_SOCK: sshServer.agentSocket,
      },
    });
    expect((await application.cli([
      "workspace",
      "exec",
      workspace.id,
      "--",
      "git",
      "status",
      "--short",
    ], { apiKey: apiKey.token })).stdout).toContain("ssh-transfer.txt");
    expect(
      (await application.json<SshServerRecord[]>(
        "/api/ssh-servers",
        { apiKey: apiKey.token },
      )).data.map((server) => server.config.id),
    ).toContain(serverId);
    expect(
      (await application.json<ChatSnapshot>(
        `/api/chats/${chat.config.id}/snapshot?full=1`,
        { apiKey: apiKey.token },
      )).data.transcript.messages.length,
    ).toBeGreaterThan(1);
    for (const jobId of [
      provisioningStarted.job.config.id,
      restartJob.job.config.id,
      failedJob.job.config.id,
      cancellationJob.job.config.id,
    ]) {
      expect(
        (await application.json<ProvisioningSnapshot>(
          `/api/provisioning-jobs/${jobId}`,
          { apiKey: apiKey.token },
        )).data.job.state.status,
      ).toMatch(/^(completed|failed|cancelled)$/);
      await application.json(
        `/api/provisioning-jobs/${jobId}/dismiss`,
        { method: "POST", body: "{}", apiKey: apiKey.token },
      );
    }
    expect(
      (await application.json<{ jobs: unknown[] }>(
        "/api/provisioning-jobs",
        { apiKey: apiKey.token },
      )).data.jobs,
    ).toEqual([]);

    await application.json(
      `/api/chats/${chat.config.id}`,
      { method: "DELETE", apiKey: apiKey.token },
    );
    await application.json(
      `/api/workspaces/${provisionedWorkspaceId}`,
      {
        method: "DELETE",
        apiKey: apiKey.token,
        body: JSON.stringify({
          deleteServerDirectory: false,
          credentialToken: null,
        }),
      },
    );
    await application.json(
      `/api/workspaces/${workspace.id}`,
      {
        method: "DELETE",
        apiKey: apiKey.token,
        body: JSON.stringify({
          deleteServerDirectory: false,
          credentialToken: null,
        }),
      },
    );
    await application.json(
      `/api/ssh-servers/${serverId}`,
      { method: "DELETE", apiKey: apiKey.token },
    );
    expect(
      (await application.json<SshServerRecord[]>(
        "/api/ssh-servers",
        { apiKey: apiKey.token },
      )).data,
    ).toEqual([]);
  } catch (error) {
    const applicationDiagnostics = await application.diagnostics();
    const sshDiagnostics = await readProcessDiagnostics(sshServer.process);
    throw new Error(
      [
        String(error),
        applicationDiagnostics,
        sshDiagnostics,
      ].filter(Boolean).join("\n\n"),
      { cause: error },
    );
  }
});
