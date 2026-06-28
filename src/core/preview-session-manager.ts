/**
 * Core manager for CLI-owned workspace live preview sessions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  type PreviewBridgeClientMessage,
  type PreviewBridgeHelloMessage,
  type PreviewSession,
  type RegisterCliPreviewOptions,
  type Workspace,
} from "../types";
import { getWorkspace, listWorkspaces, touchWorkspace } from "../persistence/workspaces";
import {
  getPreviewSession,
  listPreviewSessionsByStatuses,
  listPreviewSessionsByWorkspace,
  savePreviewSession,
} from "../persistence/preview-sessions";
import { createLogger } from "./logger";
import { previewEventEmitter } from "./event-emitter";
import { buildSshProcessConfig, getSshConnectionTargetFromWorkspace } from "./ssh-connection-target";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";

const log = createLogger("core:preview-session-manager");
const LOCAL_TUNNEL_HOST = "127.0.0.1";
const STARTUP_GRACE_MS = 500;
const STOP_TIMEOUT_MS = 2000;

interface PreviewRuntime {
  user: CurrentUser;
  targetBaseUrl: string;
  tunnel?: ChildProcess;
}

interface PreviewBridgeSocket {
  data: { previewBridgeSessionId?: string; user?: CurrentUser };
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

function normalizeInitialPath(value: string): string {
  const trimmed = value.trim() || "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function allocateLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, LOCAL_TUNNEL_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate local preview tunnel port")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForProcessStartup(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, STARTUP_GRACE_MS);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
    };
    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(stderr.trim() || `Preview tunnel exited early (code=${String(code)}, signal=${String(signal)})`));
    };
    const onStderr = (chunk: Buffer | string) => {
      stderr += chunk.toString();
    };

    child.on("error", onError);
    child.on("exit", onExit);
    child.stderr?.on("data", onStderr);
  });
}

async function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}

function encodeBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export class PreviewSessionManager {
  private runtimes = new Map<string, PreviewRuntime>();
  private initializedUserIds = new Set<string>();
  private initializingByUserId = new Map<string, Promise<void>>();

  async initialize(): Promise<void> {
    const user = requireCurrentUser();
    if (this.initializedUserIds.has(user.id)) {
      return;
    }
    const existing = this.initializingByUserId.get(user.id);
    if (existing) {
      await existing;
      return;
    }

    const initializing = this.reconcileStalePreviews();
    this.initializingByUserId.set(user.id, initializing);
    try {
      await initializing;
      this.initializedUserIds.add(user.id);
    } finally {
      this.initializingByUserId.delete(user.id);
    }
  }

  async resolveWorkspaceReference(reference: string): Promise<Workspace> {
    const normalized = reference.trim();
    if (!normalized) {
      throw new Error("Workspace is required");
    }
    const workspaceById = await getWorkspace(normalized);
    if (workspaceById) {
      return workspaceById;
    }

    const matches = (await listWorkspaces()).filter((workspace) => workspace.name === normalized);
    if (matches.length === 0) {
      throw new Error(`Workspace not found: ${normalized}`);
    }
    if (matches.length > 1) {
      const candidates = matches.map((workspace) => `${workspace.name} (${workspace.id})`).join(", ");
      throw new Error(`Workspace name is ambiguous: ${normalized}. Matching workspaces: ${candidates}`);
    }
    return matches[0]!;
  }

  async registerCliPreview(options: RegisterCliPreviewOptions): Promise<{ preview: PreviewSession; targetBaseUrl: string; tunnel?: ChildProcess }> {
    await this.initialize();
    const workspace = await this.resolveWorkspaceReference(options.workspace);
    await touchWorkspace(workspace.id);
    const sshTunnel = workspace.serverSettings.agent.transport === "ssh"
      ? await this.startSshTunnel(workspace, options.remoteHost, options.remotePort)
      : undefined;
    const targetPort = sshTunnel ? sshTunnel.localPort : options.remotePort;
    const targetHost = sshTunnel ? LOCAL_TUNNEL_HOST : options.remoteHost;
    const now = new Date().toISOString();
    const preview: PreviewSession = {
      config: {
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        remoteHost: options.remoteHost,
        remotePort: options.remotePort,
        localHost: options.localHost,
        localPort: options.localPort,
        localUrl: options.localUrl,
        initialPath: normalizeInitialPath(options.initialPath),
        cliClientId: options.cliClientId,
        cliHostname: options.cliHostname,
        createdAt: now,
        updatedAt: now,
      },
      state: {
        status: "active",
        connectedAt: now,
      },
    };
    await savePreviewSession(preview);
    this.runtimes.set(preview.config.id, {
      user: requireCurrentUser(),
      targetBaseUrl: `http://${targetHost}:${String(targetPort)}`,
      tunnel: sshTunnel?.child,
    });
    previewEventEmitter.emit({
      type: "preview.created",
      previewId: preview.config.id,
      workspaceId: workspace.id,
      preview,
      timestamp: now,
    });
    previewEventEmitter.emit({
      type: "preview.connected",
      previewId: preview.config.id,
      workspaceId: workspace.id,
      preview,
      timestamp: now,
    });
    return { preview, targetBaseUrl: `http://${targetHost}:${String(targetPort)}`, tunnel: sshTunnel?.child };
  }

  async listWorkspacePreviews(workspaceId: string): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByWorkspace(workspaceId);
  }

  async listActivePreviews(): Promise<PreviewSession[]> {
    await this.initialize();
    return await listPreviewSessionsByStatuses(["active", "closing"]);
  }

  async getPreview(id: string): Promise<PreviewSession | null> {
    await this.initialize();
    return await getPreviewSession(id);
  }

  async closePreview(id: string, reason = "Preview closed"): Promise<boolean> {
    await this.initialize();
    const preview = await getPreviewSession(id);
    if (!preview) {
      return false;
    }
    const runtime = this.runtimes.get(id);
    if (runtime?.tunnel) {
      runtime.tunnel.kill("SIGTERM");
      await waitForProcessExit(runtime.tunnel);
      if (runtime.tunnel.exitCode === null) {
        runtime.tunnel.kill("SIGKILL");
      }
    }
    this.runtimes.delete(id);
    const now = new Date().toISOString();
    const closedPreview: PreviewSession = {
      config: { ...preview.config, updatedAt: now },
      state: {
        ...preview.state,
        status: "closed",
        closedAt: now,
        error: reason,
      },
    };
    await savePreviewSession(closedPreview);
    previewEventEmitter.emit({
      type: "preview.closed",
      previewId: id,
      workspaceId: preview.config.workspaceId,
      preview: closedPreview,
      timestamp: now,
    });
    return true;
  }

  async markPreviewFailed(id: string, error: string): Promise<void> {
    const preview = await getPreviewSession(id);
    if (!preview) {
      previewEventEmitter.emit({
        type: "preview.failed",
        previewId: id,
        workspaceId: "",
        error,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const now = new Date().toISOString();
    const failedPreview: PreviewSession = {
      config: { ...preview.config, updatedAt: now },
      state: {
        ...preview.state,
        status: "failed",
        closedAt: now,
        error,
      },
    };
    await savePreviewSession(failedPreview);
    previewEventEmitter.emit({
      type: "preview.failed",
      previewId: id,
      workspaceId: preview.config.workspaceId,
      error,
      preview: failedPreview,
      timestamp: now,
    });
  }

  async handleBridgeMessage(ws: PreviewBridgeSocket, rawMessage: string | Buffer): Promise<void> {
    const message = JSON.parse(typeof rawMessage === "string" ? rawMessage : rawMessage.toString()) as PreviewBridgeClientMessage;
    if (message.type === "hello") {
      await this.handleHello(ws, message);
      return;
    }
    if (message.type === "request.start") {
      await this.handleRequest(ws, message);
    }
  }

  async closeBridgeSession(ws: PreviewBridgeSocket, reason: string): Promise<void> {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId || !ws.data.user) {
      return;
    }
    await runWithCurrentUser(ws.data.user, () => this.closePreview(previewId, reason));
    ws.data.previewBridgeSessionId = undefined;
  }

  private async handleHello(ws: PreviewBridgeSocket, message: PreviewBridgeHelloMessage): Promise<void> {
    const { preview } = await this.registerCliPreview(message);
    ws.data.previewBridgeSessionId = preview.config.id;
    ws.send(JSON.stringify({
      type: "ready",
      previewId: preview.config.id,
      workspaceId: preview.config.workspaceId,
    }));
  }

  private async handleRequest(
    ws: PreviewBridgeSocket,
    message: Extract<PreviewBridgeClientMessage, { type: "request.start" }>,
  ): Promise<void> {
    const previewId = ws.data.previewBridgeSessionId;
    if (!previewId) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview bridge is not ready" }));
      return;
    }
    const runtime = this.runtimes.get(previewId);
    if (!runtime) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: "Preview runtime is not available" }));
      return;
    }

    try {
      const targetUrl = new URL(message.path, runtime.targetBaseUrl);
      const headers = new Headers(message.headers);
      const response = await fetch(targetUrl, {
        method: message.method,
        headers,
        body: message.body ? Buffer.from(decodeBase64(message.body)) : undefined,
        redirect: "manual",
      });
      ws.send(JSON.stringify({
        type: "response.start",
        streamId: message.streamId,
        status: response.status,
        headers: Array.from(response.headers.entries()),
      }));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          ws.send(JSON.stringify({
            type: "response.body",
            streamId: message.streamId,
            body: encodeBase64(value),
          }));
        }
      }
      ws.send(JSON.stringify({ type: "response.end", streamId: message.streamId }));
    } catch (error) {
      ws.send(JSON.stringify({ type: "stream.error", streamId: message.streamId, error: String(error) }));
    }
  }

  private async reconcileStalePreviews(): Promise<void> {
    const previews = await listPreviewSessionsByStatuses(["active", "closing"]);
    for (const preview of previews) {
      const now = new Date().toISOString();
      const closedPreview: PreviewSession = {
        config: { ...preview.config, updatedAt: now },
        state: {
          ...preview.state,
          status: "closed",
          closedAt: now,
          error: "Preview was closed because the server restarted or the bridge connection was lost",
        },
      };
      await savePreviewSession(closedPreview);
      previewEventEmitter.emit({
        type: "preview.closed",
        previewId: preview.config.id,
        workspaceId: preview.config.workspaceId,
        preview: closedPreview,
        timestamp: now,
      });
    }
  }

  private async startSshTunnel(
    workspace: Workspace,
    remoteHost: string,
    remotePort: number,
  ): Promise<{ child: ChildProcess; localPort: number }> {
    const localPort = await allocateLocalPort();
    const target = getSshConnectionTargetFromWorkspace(workspace);
    const config = buildSshProcessConfig({
      target,
      connectionScope: workspace.directory,
      extraArgs: [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `${LOCAL_TUNNEL_HOST}:${String(localPort)}:${remoteHost}:${String(remotePort)}`,
      ],
      passwordHandling: "environment",
    });
    log.debug("Starting preview SSH tunnel", { workspaceId: workspace.id, localPort, remoteHost, remotePort });
    const child = spawn(config.command, config.args, {
      env: config.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitForProcessStartup(child);
    return { child, localPort };
  }
}

export const previewSessionManager = new PreviewSessionManager();
