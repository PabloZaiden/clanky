import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { E2EApplication } from "./support/application";
import { createGitFixture } from "./support/git";
import { pollUntil } from "./support/polling";
import {
  findFreeLoopbackPort,
  stopManagedProcess,
} from "./support/process";
import { operationSignal } from "./support/timeouts";
import {
  startVoiceProvider,
  stopVoiceProvider,
  type ManagedVoiceProvider,
} from "./support/voice-provider";

interface Workspace {
  id: string;
  directory: string;
}

interface ApiKeyResponse {
  token: string;
}

interface ExecutionHost {
  ref: Record<string, string>;
}

interface TerminalSession {
  config: {
    id: string;
  };
}

interface TerminalFrame {
  type?: string;
  data?: string;
  [key: string]: unknown;
}

interface RealtimeFrame {
  type?: string;
  event?: {
    action?: string;
    id?: string;
    resource?: string;
  };
}

interface VoiceSettings {
  apiKeyConfigured: boolean;
  baseUrl: string;
  capabilities: {
    text: {
      state: string;
      validated: boolean;
    };
    transcription: {
      state: string;
      validated: boolean;
    };
  };
  models: {
    text: string;
    transcription: string;
  };
  piper: {
    available: boolean;
  };
}

type RuntimeWebSocketConstructor = new (
  url: string,
  options: Bun.WebSocketOptions,
) => WebSocket;

let application: E2EApplication | undefined;
let voiceProvider: ManagedVoiceProvider | undefined;

afterEach(async () => {
  await application?.stop();
  try {
    if (voiceProvider) {
      await stopVoiceProvider(voiceProvider);
      voiceProvider = undefined;
    }
  } finally {
    await application?.cleanup();
  }
  application = undefined;
});

async function createWorkspaceAndKey(app: E2EApplication): Promise<{
  apiKey: string;
  workspace: Workspace;
}> {
  const git = await createGitFixture(app.runDirectory);
  const hostsResponse = await app.request("/api/execution-hosts");
  expect(hostsResponse.status).toBe(200);
  const hosts = await hostsResponse.json() as ExecutionHost[];
  const localHost = hosts.find((host) => host.ref["kind"] === "local");
  expect(localHost).toBeDefined();

  const workspaceResponse = await app.request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({
      name: "Local protocols",
      directory: git.repositoryDirectory,
      executionHost: localHost!.ref,
      serverSettings: {
        agent: {
          adapter: "acp",
          provider: "copilot",
        },
      },
    }),
  });
  expect(workspaceResponse.status).toBe(201);
  const workspace = await workspaceResponse.json() as Workspace;

  const keyResponse = await app.request("/api/api-keys", {
    method: "POST",
    body: JSON.stringify({
      name: "local-protocols-e2e",
      scopes: ["*"],
    }),
  });
  expect(keyResponse.status).toBe(200);
  const { token: apiKey } = await keyResponse.json() as ApiKeyResponse;
  return { apiKey, workspace };
}

function websocketUrl(app: E2EApplication, path: string): string {
  const url = new URL(path, app.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createAuthenticatedSocket(
  app: E2EApplication,
  path: string,
  apiKey: string,
): WebSocket {
  const RuntimeWebSocket = WebSocket as unknown as RuntimeWebSocketConstructor;
  return new RuntimeWebSocket(websocketUrl(app, path), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Origin: app.baseUrl,
    },
  });
}

async function exerciseTerminal(
  app: E2EApplication,
  workspace: Workspace,
  apiKey: string,
): Promise<void> {
  const createResponse = await app.request("/api/terminal-sessions", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      workspaceId: workspace.id,
      name: "E2E direct shell",
      connectionMode: "direct",
      useTmux: false,
    }),
  });
  expect(createResponse.status).toBe(201);
  const session = await createResponse.json() as TerminalSession;

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
        description: "terminal websocket connection",
        timeoutMs: 5_000,
      },
    );
    expect(connected?.["runtimeConnectionMode"]).toBe("direct");

    socket.send(JSON.stringify({
      type: "terminal.resize",
      cols: 100,
      rows: 30,
    }));
    socket.send(JSON.stringify({
      type: "terminal.input",
      data: "printf 'CLANKY_TERMINAL_E2E:%s\\n' \"$PWD\"\n",
    }));

    const terminalOutput = await pollUntil(
      () => output,
      (value) => value.includes("CLANKY_TERMINAL_E2E:"),
      {
        description: "terminal command output",
        timeoutMs: 5_000,
      },
    );
    expect(terminalOutput).toContain(workspace.directory);

    socket.send(JSON.stringify({ type: "terminal.input", data: "exit\n" }));
    await pollUntil(
      () => frames.some((frame) => frame.type === "terminal.closed"),
      Boolean,
      {
        description: "terminal shell exit",
        timeoutMs: 5_000,
      },
    );
  } finally {
    socket.close();
  }

  const deleteResponse = await app.request(
    `/api/terminal-sessions/${encodeURIComponent(session.config.id)}`,
    { method: "DELETE", apiKey },
  );
  expect(deleteResponse.status).toBe(200);
  const listResponse = await app.request(
    `/api/terminal-sessions?workspaceId=${encodeURIComponent(workspace.id)}`,
    { apiKey },
  );
  expect(await listResponse.json()).toEqual([]);
}

async function exercisePreviewAndRealtime(
  app: E2EApplication,
  workspace: Workspace,
  apiKey: string,
): Promise<void> {
  const targetPort = await findFreeLoopbackPort();
  const localPort = await findFreeLoopbackPort();
  const targetServer = Bun.serve({
    hostname: "127.0.0.1",
    port: targetPort,
    fetch(request) {
      const url = new URL(request.url);
      return Response.json({
        path: `${url.pathname}${url.search}`,
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
      });
    },
  });
  const realtimeFrames: RealtimeFrame[] = [];
  const previewFrames: TerminalFrame[] = [];
  const realtime = createAuthenticatedSocket(app, "/api/ws", apiKey);
  const preview = createAuthenticatedSocket(app, "/api/previews/bridge", apiKey);
  realtime.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      realtimeFrames.push(JSON.parse(event.data) as RealtimeFrame);
    }
  });
  preview.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      previewFrames.push(JSON.parse(event.data) as TerminalFrame);
    }
  });

  try {
    await pollUntil(
      () => ({
        preview: preview.readyState,
        realtime: realtime.readyState,
      }),
      (state) => state.preview === WebSocket.OPEN && state.realtime === WebSocket.OPEN,
      {
        description: "preview and realtime websocket connections",
        timeoutMs: 5_000,
      },
    );

    preview.send(JSON.stringify({
      type: "hello",
      target: { kind: "workspace", reference: workspace.id },
      remoteHost: "127.0.0.1",
      remotePort: targetPort,
      localHost: "127.0.0.1",
      localPort,
      localUrl: `http://127.0.0.1:${String(localPort)}`,
      initialPath: "/preview-e2e",
      cliClientId: "compiled-e2e",
      cliHostname: "e2e-host",
    }));
    const ready = await pollUntil(
      () => previewFrames.find((frame) => frame.type === "ready"),
      (frame) => frame !== undefined,
      {
        description: "preview bridge registration",
        timeoutMs: 5_000,
      },
    );
    const previewId = String(ready?.["previewId"]);
    expect(previewId).not.toBe("");

    await pollUntil(
      () => realtimeFrames.find((frame) => (
        frame.type === "event"
        && frame.event?.resource === "previews"
        && frame.event.id === previewId
        && frame.event.action === "changed"
      )),
      (frame) => frame !== undefined,
      {
        description: "preview realtime creation event",
        timeoutMs: 5_000,
      },
    );

    const previewsResponse = await app.request("/api/previews", { apiKey });
    expect(previewsResponse.status).toBe(200);
    const activePreviews = await previewsResponse.json() as Array<{
      config: { id: string };
      state: { status: string };
    }>;
    expect(activePreviews).toContainEqual(expect.objectContaining({
      config: expect.objectContaining({ id: previewId }),
      state: expect.objectContaining({ status: "active" }),
    }));

    const streamId = crypto.randomUUID();
    preview.send(JSON.stringify({
      type: "request.start",
      streamId,
      method: "GET",
      path: "/preview-e2e?value=1",
      headers: [
        ["host", "preview.local"],
        ["origin", app.baseUrl],
      ],
    }));
    await pollUntil(
      () => previewFrames.some((frame) => (
        frame.type === "response.end" && frame["streamId"] === streamId
      )),
      Boolean,
      {
        description: "preview proxied HTTP response",
        timeoutMs: 5_000,
      },
    );
    const responseStart = previewFrames.find((frame) => (
      frame.type === "response.start" && frame["streamId"] === streamId
    ));
    expect(responseStart?.["status"]).toBe(200);
    const responseBody = previewFrames
      .filter((frame) => frame.type === "response.body" && frame["streamId"] === streamId)
      .map((frame) => Buffer.from(String(frame["body"]), "base64").toString("utf8"))
      .join("");
    expect(JSON.parse(responseBody)).toEqual({
      path: "/preview-e2e?value=1",
      forwardedHost: "preview.local",
      forwardedProto: "http",
    });

    const closeResponse = await app.request(
      `/api/previews/${encodeURIComponent(previewId)}`,
      { method: "DELETE", apiKey },
    );
    expect(closeResponse.status).toBe(200);
    await pollUntil(
      () => realtimeFrames.find((frame) => (
        frame.type === "event"
        && frame.event?.resource === "previews"
        && frame.event.id === previewId
        && frame.event.action === "deleted"
      )),
      (frame) => frame !== undefined,
      {
        description: "preview realtime deletion event",
        timeoutMs: 5_000,
      },
    );
    const remainingPreviews = await (await app.request("/api/previews", { apiKey })).json();
    expect(remainingPreviews).toEqual([]);
  } finally {
    realtime.close();
    preview.close();
    await targetServer.stop(true);
  }
}

async function exerciseWorkspaceCli(
  app: E2EApplication,
  workspace: Workspace,
  apiKey: string,
): Promise<void> {
  const sourcePath = join(app.runDirectory, "cli-upload-source.txt");
  const downloadPath = join(app.runDirectory, "cli-download-target.txt");
  const contents = "transferred through the compiled Clanky CLI\n";
  await Bun.write(sourcePath, contents);

  const upload = await app.cli([
    "workspace",
    "upload",
    workspace.id,
    sourcePath,
    "--remote-path",
    "cli-transfer.txt",
    "--force",
  ], { apiKey });
  expect(upload.exitCode).toBe(0);

  const download = await app.cli([
    "workspace",
    "download",
    workspace.id,
    "cli-transfer.txt",
    "--output",
    downloadPath,
    "--force",
  ], { apiKey });
  expect(download.exitCode).toBe(0);
  expect(await Bun.file(downloadPath).text()).toBe(contents);

  const exec = await app.cli([
    "workspace",
    "exec",
    workspace.id,
    "--",
    "pwd",
  ], { apiKey });
  expect(exec.exitCode).toBe(0);
  expect(exec.stdout.trim()).toBe(workspace.directory);
}

async function exerciseWebDav(
  app: E2EApplication,
  workspace: Workspace,
  apiKey: string,
): Promise<void> {
  const port = await findFreeLoopbackPort();
  const bridge = app.startCliProcess([
    "workspace",
    "webdav",
    workspace.id,
    "--local-port",
    String(port),
  ], {
    apiKey,
    name: "webdav",
  });

  try {
    await pollUntil(
      async () => {
        const file = Bun.file(bridge.stdoutPath);
        return await file.exists() && (await file.text()).includes("WebDAV ready:");
      },
      Boolean,
      {
        description: "WebDAV bridge startup",
        timeoutMs: 5_000,
      },
    );
    const stdout = await Bun.file(bridge.stdoutPath).text();
    const mountUrl = stdout.match(/^WebDAV ready: (.+)$/m)?.[1]?.trim();
    const username = stdout.match(/^Local username: (.+)$/m)?.[1]?.trim();
    const password = stdout.match(/^Local password: (.+)$/m)?.[1]?.trim();
    expect(mountUrl).toBeDefined();
    expect(username).toBe("clanky");
    expect(password).toBeDefined();

    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    const fileUrl = new URL("dav-e2e.txt", mountUrl);
    const movedUrl = new URL("dav-e2e-moved.txt", mountUrl);

    const unauthenticated = await fetch(mountUrl!, {
      method: "PROPFIND",
      signal: operationSignal(),
    });
    expect(unauthenticated.status).toBe(401);

    const put = await fetch(fileUrl, {
      method: "PUT",
      headers: { Authorization: authorization },
      body: "written through WebDAV\n",
      signal: operationSignal(),
    });
    expect([201, 204]).toContain(put.status);

    const get = await fetch(fileUrl, {
      headers: { Authorization: authorization },
      signal: operationSignal(),
    });
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("written through WebDAV\n");

    const move = await fetch(fileUrl, {
      method: "MOVE",
      headers: {
        Authorization: authorization,
        Destination: movedUrl.toString(),
      },
      signal: operationSignal(),
    });
    expect([201, 204]).toContain(move.status);

    const listing = await fetch(mountUrl!, {
      method: "PROPFIND",
      headers: {
        Authorization: authorization,
        Depth: "1",
      },
      signal: operationSignal(),
    });
    expect(listing.status).toBe(207);
    expect(await listing.text()).toContain("dav-e2e-moved.txt");

    const deletion = await fetch(movedUrl, {
      method: "DELETE",
      headers: { Authorization: authorization },
      signal: operationSignal(),
    });
    expect(deletion.status).toBe(204);
  } finally {
    await stopManagedProcess(bridge);
  }
}

async function exerciseVoice(
  app: E2EApplication,
  provider: ManagedVoiceProvider,
): Promise<void> {
  const initial = (await app.json<VoiceSettings>("/api/voice/settings")).data;
  expect(initial.apiKeyConfigured).toBe(false);
  expect(initial.piper.available).toBe(true);

  const unsafe = await app.request("/api/voice/settings", {
    method: "PUT",
    body: JSON.stringify({
      baseUrl: "https://127.0.0.1/v1",
      apiKey: "unsafe-key",
      models: {
        transcription: "fixture-transcription",
        text: "fixture-text",
      },
      languageHints: ["es", "en"],
    }),
  });
  expect(unsafe.status).toBe(400);
  expect(await unsafe.json()).toMatchObject({
    error: "voice_unsafe_provider_url",
  });

  const configured = (await app.json<VoiceSettings>(
    "/api/voice/settings",
    {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: provider.baseUrl,
        apiKey: "voice-e2e-secret",
        models: {
          transcription: "fixture-transcription",
          text: "fixture-text",
        },
        languageHints: ["es", "en"],
      }),
    },
  )).data;
  expect(configured).toMatchObject({
    apiKeyConfigured: true,
    baseUrl: provider.baseUrl,
    capabilities: {
      transcription: {
        state: "unvalidated",
        validated: false,
      },
      text: {
        state: "unvalidated",
        validated: false,
      },
    },
  });
  expect(configured).not.toHaveProperty("apiKey");

  const transcriptionValidation = (await app.json<{
    success: boolean;
    settings: VoiceSettings;
  }>("/api/voice/validate", {
    method: "POST",
    body: JSON.stringify({ capability: "transcription" }),
  })).data;
  expect(transcriptionValidation.success).toBe(true);
  expect(transcriptionValidation.settings.capabilities.transcription).toMatchObject({
    state: "valid",
    validated: true,
  });
  const textValidation = (await app.json<{
    success: boolean;
    settings: VoiceSettings;
  }>("/api/voice/validate", {
    method: "POST",
    body: JSON.stringify({ capability: "text" }),
  })).data;
  expect(textValidation.success).toBe(true);
  expect(textValidation.settings.capabilities.text).toMatchObject({
    state: "valid",
    validated: true,
  });

  const form = new FormData();
  form.append(
    "file",
    new File(
      [new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x41, 0x56, 0x45])],
      "voice-e2e.wav",
      { type: "audio/wav" },
    ),
  );
  const transcription = await app.request("/api/voice/transcribe", {
    method: "POST",
    body: form,
  });
  expect(transcription.status).toBe(200);
  expect(await transcription.json()).toEqual({
    text: "transcribed by the external voice fixture",
  });

  await app.restart({
    env: {
      NODE_EXTRA_CA_CERTS: provider.certificatePath,
    },
  });
  expect((await app.json<VoiceSettings>("/api/voice/settings")).data).toMatchObject({
    apiKeyConfigured: true,
    baseUrl: provider.baseUrl,
    capabilities: {
      transcription: {
        state: "valid",
        validated: true,
      },
      text: {
        state: "valid",
        validated: true,
      },
    },
  });
}

describe("compiled local protocol journey", () => {
  test("crosses CLI file transfer, WebDAV, and terminal websocket boundaries", async () => {
    application = await E2EApplication.create();
    voiceProvider = await startVoiceProvider(application.runDirectory);
    try {
      await application.start({
        env: {
          NODE_EXTRA_CA_CERTS: voiceProvider.certificatePath,
        },
      });
      const { apiKey, workspace } = await createWorkspaceAndKey(application);

      await exerciseWorkspaceCli(application, workspace, apiKey);
      await exerciseWebDav(application, workspace, apiKey);
      await exerciseTerminal(application, workspace, apiKey);
      await exercisePreviewAndRealtime(application, workspace, apiKey);
      await exerciseVoice(application, voiceProvider);
    } catch (error) {
      const diagnostics = await application.diagnostics();
      if (diagnostics.length > 0) {
        console.error(diagnostics);
      }
      throw error;
    }
  }, 120_000);
});
