import { spawn } from "node:child_process";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { VncSession } from "@/shared";
import {
  deleteVncSession,
  findActiveVncSession,
  getVncSession,
  listVncSessionsBySshServerId,
  listVncSessionsByStatuses,
  listReservedVncLocalPortsForMaintenance,
  saveVncSession,
} from "../persistence/vnc-sessions";
import { getSshServerConfig } from "../persistence/ssh-servers";
import { sshCredentialManager } from "./ssh-credential-manager";
import { buildSshProcessConfig, getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { ensureLocalPortAvailable } from "./local-port-allocator";
import { isProcessAlive, waitForProcessExit, waitForProcessStartup } from "./process-lifecycle";
import { createLogger } from "./logger";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";

const log = createLogger("core:vnc-session-manager");
const VNC_REMOTE_HOST = "127.0.0.1";
const ACTIVE_STATUSES = new Set<VncSession["state"]["status"]>(["starting", "active", "stopping"]);
const STOP_TIMEOUT_MS = 2_000;
const TCP_CONNECT_RETRY_INTERVAL_MS = 50;
const TCP_CONNECT_TIMEOUT_MS = 2_000;

interface RuntimeHandle {
  child: ChildProcess;
  deleting: boolean;
  user: CurrentUser;
}

export class VncSessionManager {
  private runtimeHandles = new Map<string, RuntimeHandle>();
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
    const initializing = this.reconcilePersistedSessions();
    this.initializingByUserId.set(user.id, initializing);
    try {
      await initializing;
      this.initializedUserIds.add(user.id);
    } finally {
      this.initializingByUserId.delete(user.id);
    }
  }

  async listServerSessions(sshServerId: string): Promise<VncSession[]> {
    await this.initialize();
    return await listVncSessionsBySshServerId(sshServerId);
  }

  async getSession(id: string): Promise<VncSession | null> {
    await this.initialize();
    return await getVncSession(id);
  }

  async createOrResumeSession(options: {
    sshServerId: string;
    remotePort: number;
    credentialToken: string | null;
  }): Promise<VncSession> {
    await this.initialize();
    const existing = await findActiveVncSession(options.sshServerId, options.remotePort);
    if (existing) {
      return existing;
    }

    const server = await getSshServerConfig(options.sshServerId);
    if (!server) {
      throw new Error(`SSH server not found: ${options.sshServerId}`);
    }
    const credentialToken = options.credentialToken?.trim();
    if (!credentialToken) {
      throw new Error("SSH credential token is required to start a VNC session");
    }
    const password = sshCredentialManager.getPasswordForToken(server.id, credentialToken);
    const localPort = await ensureLocalPortAvailable(await this.getReservedLocalPorts());
    const now = new Date().toISOString();
    const session: VncSession = {
      config: {
        id: crypto.randomUUID(),
        sshServerId: options.sshServerId,
        remoteHost: VNC_REMOTE_HOST,
        remotePort: options.remotePort,
        localPort,
        createdAt: now,
        updatedAt: now,
      },
      state: { status: "starting" },
    };
    await saveVncSession(session);

    try {
      const spawnConfig = this.buildSpawnConfig(server, password, session);
      const child = spawn(spawnConfig.command, spawnConfig.args, {
        env: spawnConfig.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.attachRuntimeHandle(session, child, requireCurrentUser());
      await waitForProcessStartup(child);
      await this.waitForLocalPort(session.config.localPort);
      const activeSession: VncSession = {
        config: { ...session.config, updatedAt: new Date().toISOString() },
        state: {
          status: "active",
          pid: child.pid ?? undefined,
          connectedAt: new Date().toISOString(),
        },
      };
      await saveVncSession(activeSession);
      return activeSession;
    } catch (error) {
      this.runtimeHandles.delete(session.config.id);
      const failedSession: VncSession = {
        config: { ...session.config, updatedAt: new Date().toISOString() },
        state: { status: "failed", error: String(error) },
      };
      await saveVncSession(failedSession);
      throw error;
    }
  }

  async closeSession(id: string): Promise<boolean> {
    await this.initialize();
    const session = await getVncSession(id);
    if (!session) {
      return false;
    }
    await this.stopSession(session);
    return await deleteVncSession(id);
  }

  async openTcpSocket(id: string): Promise<{ session: VncSession; socket: net.Socket }> {
    await this.initialize();
    const session = await getVncSession(id);
    if (!session) {
      throw new Error("VNC session not found");
    }
    if (session.state.status !== "active") {
      throw new Error("VNC session is not active");
    }
    return {
      session,
      socket: net.createConnection({ host: "127.0.0.1", port: session.config.localPort }),
    };
  }

  private buildSpawnConfig(server: NonNullable<Awaited<ReturnType<typeof getSshServerConfig>>>, password: string, session: VncSession) {
    return buildSshProcessConfig({
      target: getSshConnectionTargetFromServer(server, password),
      connectionScope: `vnc:${server.id}:${session.config.remotePort}`,
      extraArgs: [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        `127.0.0.1:${String(session.config.localPort)}:${session.config.remoteHost}:${String(session.config.remotePort)}`,
      ],
      passwordHandling: "environment",
    });
  }

  private attachRuntimeHandle(session: VncSession, child: ChildProcess, user: CurrentUser): void {
    this.runtimeHandles.set(session.config.id, { child, deleting: false, user });
    child.once("exit", (code, signal) => {
      const handle = this.runtimeHandles.get(session.config.id);
      this.runtimeHandles.delete(session.config.id);
      if (handle && !handle.deleting) {
        void runWithCurrentUser(handle.user, () => this.markUnexpectedExit(session.config.id, code, signal));
      }
    });
  }

  private async markUnexpectedExit(id: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    const session = await getVncSession(id);
    if (!session || !ACTIVE_STATUSES.has(session.state.status)) {
      return;
    }
    await saveVncSession({
      config: { ...session.config, updatedAt: new Date().toISOString() },
      state: {
        status: "failed",
        error: `VNC SSH tunnel exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      },
    });
  }

  private async stopSession(session: VncSession): Promise<void> {
    await saveVncSession({
      config: { ...session.config, updatedAt: new Date().toISOString() },
      state: { ...session.state, status: "stopping" },
    });

    const handle = this.runtimeHandles.get(session.config.id);
    if (handle) {
      handle.deleting = true;
      handle.child.kill("SIGTERM");
      await waitForProcessExit(handle.child, STOP_TIMEOUT_MS);
      if (handle.child.exitCode === null) {
        handle.child.kill("SIGKILL");
      }
      this.runtimeHandles.delete(session.config.id);
      return;
    }

    if (session.state.pid && isProcessAlive(session.state.pid)) {
      try {
        process.kill(session.state.pid, "SIGTERM");
      } catch (error) {
        log.warn("Failed to stop VNC tunnel process", { id: session.config.id, pid: session.state.pid, error: String(error) });
      }
    }
  }

  private async getReservedLocalPorts(): Promise<Set<number>> {
    return await listReservedVncLocalPortsForMaintenance(["starting", "active", "stopping"]);
  }

  private async waitForLocalPort(localPort: number): Promise<void> {
    const deadline = Date.now() + TCP_CONNECT_TIMEOUT_MS;
    let lastError: unknown;

    while (Date.now() <= deadline) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
          socket.once("connect", () => {
            socket.end();
            resolve();
          });
          socket.once("error", reject);
        });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, TCP_CONNECT_RETRY_INTERVAL_MS));
      }
    }

    throw new Error(`VNC SSH tunnel did not open local port ${String(localPort)}: ${String(lastError)}`);
  }

  private async reconcilePersistedSessions(): Promise<void> {
    const sessions = await listVncSessionsByStatuses(["starting", "active", "stopping"]);
    for (const session of sessions) {
      if (session.state.pid && isProcessAlive(session.state.pid)) {
        try {
          process.kill(session.state.pid, "SIGTERM");
        } catch {
          // Stale records are marked stopped even when the old process is already gone.
        }
      }
      await saveVncSession({
        config: { ...session.config, updatedAt: new Date().toISOString() },
        state: {
          status: "stopped",
          error: "VNC session was reset during server startup and must be recreated",
        },
      });
    }
  }
}

export const vncSessionManager = new VncSessionManager();
