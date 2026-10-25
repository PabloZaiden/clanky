import { expect, test } from "bun:test";
import { createFileAttachment, expectedFileInspection } from "./support/attachments";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  compiledClankyCommand,
  enrollMeshWorker,
  meshJsonRequest,
  meshNodeDiagnostics,
  startMeshNode,
  stopMeshNode,
  type ManagedMeshNode,
} from "./support/mesh-cluster";
import { pollUntil } from "./support/polling";
import { MESH_OPERATION_TIMEOUT_MS } from "./support/timeouts";
import {
  installExternalCodexProvider,
  installExternalNativeCopilotProvider,
} from "./support/provider";
import { createPng } from "./support/png-fixtures";

const IMAGE_RECEIPT = "E2E image received: image/png; PNG signature OK";
const MESH_EXECUTION_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MESSAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const LARGE_IMAGE_MESH_REQUEST_TIMEOUT_MS = 30_000;

interface MeshRegistration {
  workerNodeId: string;
}

interface ControllerStatus {
  workers: MeshRegistration[];
}

interface ExecutionHost {
  ref: {
    kind: string;
    nodeId?: string;
  };
}

interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface Workspace {
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

interface ChatMessageResponse {
  chat: Chat;
}

interface ChatSnapshot {
  transcript: {
    messages: Array<{
      attachments?: Array<{
        filename: string;
        mimeType: string;
        size: number;
        data: string;
      }>;
      content: string;
      role: string;
    }>;
  };
}

function createPngAttachment(width: number, height: number, filename: string) {
  const image = createPng(width, height);
  return {
    id: crypto.randomUUID(),
    filename,
    mimeType: "image/png",
    data: image.toString("base64"),
    size: image.byteLength,
  };
}

function createLargePngAttachment() {
  const image = createPngAttachment(2048, 2558, "e2e-large-image.png");
  if (
    image.size <= MESSAGE_ATTACHMENT_MAX_BYTES - 16 * 1024
    || image.size > MESSAGE_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error("The generated PNG must be close to, but within, the 20 MiB attachment limit.");
  }
  return image;
}

function createSmallPngAttachment() {
  return createPngAttachment(256, 256, "e2e-small-image.png");
}

async function executeOnWorker(
  controller: ManagedMeshNode,
  workerNodeId: string,
  input: {
    command: string;
    args: string[];
    cwd: string;
  },
): Promise<ExecutionResult> {
  const response = await meshJsonRequest<ExecutionResult>(
    controller,
    `/api/execution-hosts/mesh/${encodeURIComponent(workerNodeId)}/exec`,
    {
      method: "POST",
      body: { ...input, timeoutMs: MESH_OPERATION_TIMEOUT_MS },
    },
  );
  if (response.status !== 200 || !response.body.success) {
    throw new Error(`Mesh execution failed: HTTP ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function waitForIdleChat(controller: ManagedMeshNode, chatId: string): Promise<Chat> {
  const response = await pollUntil(
    async () => await meshJsonRequest<Chat>(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}`,
    ),
    (candidate) => candidate.status === 200
      && (candidate.body.state.status === "idle" || candidate.body.state.status === "failed"),
    {
      description: `Mesh image chat ${chatId} to settle`,
      timeoutMs: 10_000,
      formatLastObserved: (candidate) => JSON.stringify(candidate),
    },
  );
  return response.body;
}

test("compiled Mesh hosts deliver large images to native Codex and Copilot", async () => {
  const image = createLargePngAttachment();
  const smallImage = createSmallPngAttachment();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-native-image-e2e-"));
  const providerBinDirectory = join(fixtureDirectory, "bin");
  const homeDirectory = join(fixtureDirectory, "home");
  const nodes: ManagedMeshNode[] = [];
  let primaryError: unknown;
  try {
    expect(image.size).toBeGreaterThan(MESSAGE_ATTACHMENT_MAX_BYTES - 16 * 1024);
    expect(image.size).toBeLessThanOrEqual(MESSAGE_ATTACHMENT_MAX_BYTES);
    expect(image.size).toBeGreaterThan(MESH_EXECUTION_MAX_MESSAGE_BYTES);
    await Promise.all([
      installExternalCodexProvider(providerBinDirectory),
      installExternalNativeCopilotProvider(providerBinDirectory),
      mkdir(homeDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const command = await compiledClankyCommand();
    const controller = await startMeshNode({
      role: "controller",
      command,
      instanceName: "e2e-image-controller",
      environment: { HOME: homeDirectory },
    });
    nodes.push(controller);
    const worker = await startMeshNode({
      role: "worker",
      command,
      instanceName: "e2e-image-worker",
      environment: {
        HOME: homeDirectory,
        PATH: `${providerBinDirectory}${delimiter}${process.env["PATH"] ?? ""}`,
      },
    });
    nodes.push(worker);
    await enrollMeshWorker(controller, worker);

    const registration = await pollUntil(
      async () => await meshJsonRequest<ControllerStatus>(controller, "/api/mesh/status"),
      (response) => response.status === 200 && response.body.workers.length === 1,
      {
        description: "native image worker registration",
        timeoutMs: 10_000,
        formatLastObserved: (response) => JSON.stringify(response),
      },
    );
    const workerNodeId = registration.body.workers[0]!.workerNodeId;
    const hosts = await meshJsonRequest<ExecutionHost[]>(controller, "/api/execution-hosts");
    expect(hosts.status).toBe(200);
    const workerHost = hosts.body.find(
      (host) => host.ref.kind === "mesh" && host.ref.nodeId === workerNodeId,
    );
    expect(workerHost).toBeDefined();

    const providers = [
      { adapter: "codex", provider: "codex", modelId: "e2e-codex-model" },
      { adapter: "copilot", provider: "copilot", modelId: "e2e-copilot-model" },
    ] as const;
    for (const provider of providers) {
      const workspaceDirectory = join(worker.dataDir, `workspace-${provider.provider}`);
      const createDirectory = process.platform === "win32"
        ? {
            command: "powershell.exe",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `[System.IO.Directory]::CreateDirectory('${workspaceDirectory.replaceAll("'", "''")}') | Out-Null`,
            ],
          }
        : { command: "mkdir", args: ["-p", workspaceDirectory] };
      await executeOnWorker(controller, workerNodeId, {
        ...createDirectory,
        cwd: worker.dataDir,
      });

      const createdWorkspace = await meshJsonRequest<Workspace>(
        controller,
        "/api/workspaces",
        {
          method: "POST",
          body: {
            name: `Mesh ${provider.provider} image workspace`,
            directory: workspaceDirectory,
            executionHost: workerHost!.ref,
            workspaceType: "directory",
            allowWorktrees: false,
            serverSettings: {
              agent: { adapter: provider.adapter, provider: provider.provider },
            },
          },
        },
      );
      expect(createdWorkspace.status).toBe(201);

      const models = await meshJsonRequest<Model[]>(
        controller,
        `/api/models?workspaceId=${encodeURIComponent(createdWorkspace.body.id)}`,
        { timeoutMs: 10_000 },
      );
      expect(models.status).toBe(200);
      const model = models.body.find(
        (candidate) => candidate.providerID === provider.provider && candidate.connected,
      );
      expect(model?.modelID).toBe(provider.modelId);
      const createdChat = await meshJsonRequest<Chat>(
        controller,
        "/api/chats",
        {
          method: "POST",
          body: {
            name: `Mesh ${provider.provider} large image chat`,
            workspaceId: createdWorkspace.body.id,
            model: { providerID: model!.providerID, modelID: model!.modelID, variant: "" },
            useWorktree: false,
          },
        },
      );
      expect(createdChat.status).toBe(201);

      const chatId = createdChat.body.config.id;
      const started = await meshJsonRequest<ChatMessageResponse>(
        controller,
        `/api/chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          body: {
            message: "Inspect the attached image.",
            attachments: [image],
          },
          timeoutMs: LARGE_IMAGE_MESH_REQUEST_TIMEOUT_MS,
        },
      );
      expect(started.status).toBe(200);
      expect((await waitForIdleChat(controller, chatId)).state.status).toBe("idle");
      const snapshot = await pollUntil(
        async () => await meshJsonRequest<ChatSnapshot>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/snapshot?full=1`,
        ),
        (response) => response.status === 200
          && response.body.transcript.messages.some(
            (message) => message.role === "assistant"
              && message.content.includes(IMAGE_RECEIPT),
          ),
        {
          description: `${provider.provider} to receive the large image on the selected worker`,
          timeoutMs: 10_000,
          formatLastObserved: (response) => JSON.stringify(
            response.body.transcript.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.content.slice(0, 300)),
          ),
        },
      );
      expect(snapshot.body.transcript.messages.some(
        (message) => message.role === "assistant"
          && message.content.includes(IMAGE_RECEIPT),
      )).toBe(true);

      if (provider.provider === "codex") {
        const inputFile = createFileAttachment("estimate.pdf", "%PDF-1.4\nSynthetic Mesh document\n%%EOF\n", "application/pdf");
        const generatedImagePrompt = await meshJsonRequest<ChatMessageResponse>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: "POST",
            body: {
              message: "Inspect the attached files and image. Generate a PNG larger than two MiB.",
              attachments: [inputFile, smallImage],
              clientId: crypto.randomUUID(),
            },
          },
        );
        expect(generatedImagePrompt.status).toBe(200);
        const generatedImageChat = await waitForIdleChat(controller, chatId);
        if (generatedImageChat.state.status !== "idle") {
          throw new Error(`Codex-generated Mesh image chat failed: ${JSON.stringify(generatedImageChat.state)}`);
        }

        const generatedImageSnapshot = await pollUntil(
          async () => await meshJsonRequest<ChatSnapshot>(
            controller,
            `/api/chats/${encodeURIComponent(chatId)}/snapshot?full=1`,
          ),
          (response) => response.status === 200
            && response.body.transcript.messages.some((message) => (
              message.role === "assistant"
              && message.attachments?.some((attachment) => attachment.mimeType === "image/png")
            )),
          {
            description: "Codex-generated Mesh image to appear in the public chat snapshot",
            timeoutMs: 10_000,
            formatLastObserved: (response) => response.status === 200
              ? JSON.stringify(response.body.transcript.messages
                .filter((message) => message.role === "assistant")
                .map((message) => ({
                  content: message.content.slice(0, 160),
                  attachments: message.attachments?.map(({ filename, mimeType, size }) => ({
                    filename,
                    mimeType,
                    size,
                  })),
                })))
              : JSON.stringify(response),
          },
        );
        const generatedImage = generatedImageSnapshot.body.transcript.messages
          .flatMap((message) => message.role === "assistant" ? message.attachments ?? [] : [])
          .find((attachment) => attachment.mimeType === "image/png");
        expect(generatedImage).toBeDefined();
        expect(generatedImage!.size).toBeGreaterThan(MESH_EXECUTION_MAX_MESSAGE_BYTES);
        expect(Buffer.byteLength(generatedImage!.data, "base64")).toBe(generatedImage!.size);
        expect(generatedImageSnapshot.body.transcript.messages.some((message) =>
          message.role === "assistant" && message.content.includes(expectedFileInspection(inputFile).sha256)
        )).toBe(true);
      }
    }
  } catch (error) {
    primaryError = error;
    for (const node of nodes) {
      const diagnostics = meshNodeDiagnostics(node);
      if (diagnostics.length > 0) {
        console.error(`${node.role} diagnostics:\n${diagnostics}`);
      }
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const node of nodes.reverse()) {
      try {
        await stopMeshNode(node);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(fixtureDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        primaryError === undefined ? cleanupFailures : [primaryError, ...cleanupFailures],
        "Failed to clean up native Mesh image E2E fixtures",
      );
    }
  }
}, 120_000);
