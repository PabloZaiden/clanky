import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { deflateSync } from "node:zlib";
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
import {
  installExternalCodexProvider,
  installExternalNativeCopilotProvider,
} from "./support/provider";

const IMAGE_RECEIPT = "E2E image received: image/png; PNG signature OK";
const MESH_EXECUTION_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MESSAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const MESSAGE_ATTACHMENT_MAX_TURN_BYTES = 40 * 1024 * 1024;
const LARGE_IMAGE_MESH_REQUEST_TIMEOUT_MS = 30_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  CRC32_TABLE[value] = crc >>> 0;
}

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
    queuedMessages?: Array<{
      id: string;
      content: string;
    }>;
  };
}

interface ChatMessageResponse {
  chat: Chat;
}

interface ChatSteerResponse {
  admission: {
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

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const crcInput = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of crcInput) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, crcInput, checksum]);
}

function createPngAttachment(width: number, height: number, filename: string) {
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  let seed = 0x12345678;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * rowBytes;
    pixels[rowOffset] = 0;
    for (let x = 1; x < rowBytes; x += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[rowOffset + x] = seed >>> 24;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const image = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 0 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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
      body: { ...input, timeoutMs: 5_000 },
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

async function waitForStreamingChat(controller: ManagedMeshNode, chatId: string): Promise<Chat> {
  const response = await pollUntil(
    async () => await meshJsonRequest<Chat>(
      controller,
      `/api/chats/${encodeURIComponent(chatId)}`,
    ),
    (candidate) => candidate.status === 200 && candidate.body.state.status === "streaming",
    {
      description: `Mesh image chat ${chatId} to enter its active turn`,
      timeoutMs: 10_000,
      formatLastObserved: (candidate) => JSON.stringify(candidate),
    },
  );
  return response.body;
}

test("compiled Mesh hosts deliver large images to native Codex and Copilot", async () => {
  const image = createLargePngAttachment();
  const secondImage = {
    ...image,
    id: crypto.randomUUID(),
    filename: "e2e-large-image-2.png",
  };
  const smallImage = createSmallPngAttachment();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), "clanky-mesh-native-image-e2e-"));
  const providerBinDirectory = join(fixtureDirectory, "bin");
  const homeDirectory = join(fixtureDirectory, "home");
  const nodes: ManagedMeshNode[] = [];
  let primaryError: unknown;
  try {
    expect(image.size).toBeGreaterThan(MESSAGE_ATTACHMENT_MAX_BYTES - 16 * 1024);
    expect(image.size).toBeLessThanOrEqual(MESSAGE_ATTACHMENT_MAX_BYTES);
    expect(image.size * 2).toBeLessThanOrEqual(MESSAGE_ATTACHMENT_MAX_TURN_BYTES);
    expect(image.size * 2 + smallImage.size).toBeGreaterThan(MESSAGE_ATTACHMENT_MAX_TURN_BYTES);
    expect(image.size).toBeGreaterThan(MESH_EXECUTION_MAX_MESSAGE_BYTES);
    expect(image.data.length).toBeGreaterThan(MESH_EXECUTION_MAX_MESSAGE_BYTES);
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
            autoApprovePermissions: true,
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
            message: "Wait for a steering instruction.",
            attachments: [],
          },
        },
      );
      expect(started.status).toBe(200);
      await waitForStreamingChat(controller, chatId);

      if (provider.provider === "codex") {
        const excessiveSinglePrompt = await meshJsonRequest<unknown>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: "POST",
            body: {
              message: "This prompt exceeds the aggregate attachment limit.",
              attachments: [image, secondImage, smallImage],
              clientId: crypto.randomUUID(),
            },
          },
        );
        expect(excessiveSinglePrompt.status).toBe(400);
      }

      const clientId = crypto.randomUUID();
      const queued = await meshJsonRequest<ChatMessageResponse>(
        controller,
        `/api/chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          body: {
            message: provider.provider === "copilot"
              ? "Add both images and keep waiting."
              : "Inspect both attached images.",
            attachments: [image, secondImage],
            clientId,
          },
        },
      );
      expect(queued.status).toBe(200);
      const queuedInput = queued.body.chat.state.queuedMessages?.find(
        (message) => message.content === (
          provider.provider === "copilot"
            ? "Add both images and keep waiting."
            : "Inspect both attached images."
        ),
      );
      expect(queuedInput).toBeDefined();

      const excessiveQueued = await meshJsonRequest<unknown>(
        controller,
        `/api/chats/${encodeURIComponent(chatId)}/messages`,
        {
          method: "POST",
          body: {
            message: "Add one more attachment to the same turn.",
            attachments: [smallImage],
            clientId,
          },
        },
      );
      expect(excessiveQueued.status).toBe(413);

      const steered = await meshJsonRequest<ChatSteerResponse>(
        controller,
        `/api/chats/${encodeURIComponent(chatId)}/queued-messages/${encodeURIComponent(queuedInput!.id)}/steer`,
        {
          method: "POST",
          body: {},
          timeoutMs: LARGE_IMAGE_MESH_REQUEST_TIMEOUT_MS,
        },
      );
      expect(steered.status).toBe(200);
      expect(steered.body.admission.status).toBe("accepted");

      if (provider.provider === "copilot") {
        await waitForStreamingChat(controller, chatId);
        const extraQueued = await meshJsonRequest<ChatMessageResponse>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: "POST",
            body: {
              message: "Try steering one more image.",
              attachments: [smallImage],
              clientId: crypto.randomUUID(),
            },
          },
        );
        expect(extraQueued.status).toBe(200);
        const extraInput = extraQueued.body.chat.state.queuedMessages?.find(
          (message) => message.content === "Try steering one more image.",
        );
        expect(extraInput).toBeDefined();
        const excessiveSteering = await meshJsonRequest<unknown>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/queued-messages/${encodeURIComponent(extraInput!.id)}/steer`,
          { method: "POST", body: {} },
        );
        expect(excessiveSteering.status).toBe(413);
        const removed = await meshJsonRequest<Chat>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/queued-messages/${encodeURIComponent(extraInput!.id)}`,
          { method: "DELETE" },
        );
        expect(removed.status).toBe(200);

        const finishQueued = await meshJsonRequest<ChatMessageResponse>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/messages`,
          {
            method: "POST",
            body: {
              message: "Finish the request.",
              attachments: [],
              clientId: crypto.randomUUID(),
            },
          },
        );
        expect(finishQueued.status).toBe(200);
        const finishInput = finishQueued.body.chat.state.queuedMessages?.find(
          (message) => message.content === "Finish the request.",
        );
        expect(finishInput).toBeDefined();
        const finished = await meshJsonRequest<ChatSteerResponse>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/queued-messages/${encodeURIComponent(finishInput!.id)}/steer`,
          { method: "POST", body: {} },
        );
        expect(finished.status).toBe(200);
        expect(finished.body.admission.status).toBe("accepted");
      }

      expect((await waitForIdleChat(controller, chatId)).state.status).toBe("idle");
      const snapshot = await pollUntil(
        async () => await meshJsonRequest<ChatSnapshot>(
          controller,
          `/api/chats/${encodeURIComponent(chatId)}/snapshot?full=1`,
        ),
        (response) => response.status === 200
          && response.body.transcript.messages.some(
            (message) => message.role === "assistant"
              && message.content.split(IMAGE_RECEIPT).length - 1 === 2,
          ),
        {
          description: `${provider.provider} public chat response to confirm both large-image receipts`,
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
          && message.content.split(IMAGE_RECEIPT).length - 1 === 2,
      )).toBe(true);
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
