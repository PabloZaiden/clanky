import { spawn } from "node:child_process";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { VncSession } from "@/shared";
import {
  deleteVncSession,
  findActiveVncSessionByExecutionHost,
  getVncSession,
  listVncSessionsByExecutionHostId,
  listVncSessionsByStatuses,
  listReservedVncLocalPortsForMaintenance,
  saveVncSession,
} from "../persistence/vnc-sessions";
import { getSshServerConfig } from "../persistence/ssh-servers";
import { sshCredentialManager } from "./ssh-credential-manager";
import { buildSshProcessConfig, getSshConnectionTargetFromServer } from "./ssh-connection-target";
import { ensureLocalPortAvailable } from "./local-port-allocator";
import { isProcessAlive, waitForProcessExit, waitForProcessStartup } from "./process-lifecycle";
import { createLogger } from "@pablozaiden/webapp/server";
import { requireCurrentUser, runWithCurrentUser } from "./user-context";
import { DomainError, isDomainError } from "./domain-error";
import type { ExecutionHostRef } from "@/shared";
import {
  getRegisteredSshServerId,
  isWorkspaceSshExecutionHostRef,
} from "@/shared/execution-host";
import { executionHostService } from "./execution-host-service";
import { getWorkspaceSshTarget } from "../persistence/workspace-execution-targets";
import type { SshConnectionTarget } from "./ssh-connection-target";
import {
  openForwardedTcpTunnel,
  openTcpTunnel,
  type TcpTunnel,
} from "./tcp-tunnel";

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

  async listHostSessions(host: ExecutionHostRef): Promise<VncSession[]> {
    await this.initialize();
    const persisted = executionHostService.validateBinding(
      executionHostService.getBinding(host),
    );
    return await listVncSessionsByExecutionHostId(persisted.id);
  }

  async getSession(id: string): Promise<VncSession | null> {
    await this.initialize();
    return await getVncSession(id);
  }

  async createOrResumeSession(options: {
    executionHost: ExecutionHostRef;
    remotePort: number;
    credentialToken: string | null;
  }): Promise<VncSession> {
    await this.initialize();
    const ref = options.executionHost;
    const executionHostBinding = executionHostService.getBinding(ref);
    const executionHost = executionHostService.validateBinding(executionHostBinding);
    const serverId = getRegisteredSshServerId(ref);
    const server = serverId
      ? await getSshServerConfig(serverId)
      : null;
    let sshTarget: SshConnectionTarget | null = null;

    if (serverId && !server) {
      throw new DomainError("ssh_server_not_found", "SSH server not found", {
        details: { serverId },
      });
    }
    if (serverId) {
      const credentialToken = options.credentialToken?.trim();
      if (!credentialToken) {
        throw new DomainError(
          "invalid_credential_token",
          "SSH credential token is required to start a VNC session",
        );
      }
      const password = sshCredentialManager.getPasswordForToken(serverId, credentialToken);
      sshTarget = getSshConnectionTargetFromServer(server!, password);
    } else if (isWorkspaceSshExecutionHostRef(ref)) {
      const target = await getWorkspaceSshTarget(ref.workspaceId);
      if (!target) {
        throw new DomainError(
          "workspace_execution_target_missing",
          "The workspace SSH execution target is not configured.",
          { details: { workspaceId: ref.workspaceId } },
        );
      }
      sshTarget = {
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
      };
    } else if (ref.kind === "ssh") {
      throw new DomainError(
        "ssh_server_not_found",
        "Workspace-owned SSH targets require a workspace-bound VNC session.",
      );
    }

    const existing = await findActiveVncSessionByExecutionHost(
      executionHost.id,
      options.remotePort,
    );
    if (existing) {
      return existing;
    }

    const localPort = await ensureLocalPortAvailable(await this.getReservedLocalPorts());
    const now = new Date().toISOString();
    const session: VncSession = {
      config: {
        id: crypto.randomUUID(),
        executionHostBinding,
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
      if (!sshTarget) {
        const activeSession: VncSession = {
          config: { ...session.config, updatedAt: new Date().toISOString() },
          state: {
            status: "active",
            connectedAt: new Date().toISOString(),
          },
        };
        await saveVncSession(activeSession);
        return activeSession;
      }
      const spawnConfig = this.buildSpawnConfig(sshTarget, session);
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
      const failure = isDomainError(error)
        ? error
        : new DomainError(
          "vnc_session_start_failed",
          "Failed to start VNC session",
          {
            cause: error,
            details: { sessionId: session.config.id },
          },
        );
      const failedSession: VncSession = {
        config: { ...session.config, updatedAt: new Date().toISOString() },
        state: { status: "failed", error: failure.message },
      };
      await saveVncSession(failedSession);
      throw failure;
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

  async openTcpSocket(id: string): Promise<{ session: VncSession; socket: TcpTunnel }> {
    await this.initialize();
    const session = await getVncSession(id);
    if (!session) {
      throw new DomainError("vnc_session_not_found", "VNC session not found", {
        details: { sessionId: id },
      });
    }
    if (session.state.status !== "active") {
      throw new DomainError("vnc_session_not_active", "VNC session is not active", {
        details: { sessionId: id, status: session.state.status },
      });
    }
    const binding = session.config.executionHostBinding;
    if (!binding) {
      throw new DomainError("execution_host_unavailable", "The VNC execution host is unavailable.");
    }
    if (binding.host.kind !== "ssh") {
      return {
        session,
        socket: await openTcpTunnel({
          binding,
          remoteHost: session.config.remoteHost,
          remotePort: session.config.remotePort,
        }),
      };
    }
    return {
      session,
      socket: openForwardedTcpTunnel(session.config.localPort),
    };
  }

  private buildSpawnConfig(target: SshConnectionTarget, session: VncSession) {
    return buildSshProcessConfig({
      target,
      connectionScope: `vnc:${target.host}:${String(target.port)}:${session.config.remotePort}`,
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

    throw new DomainError(
      "vnc_tunnel_failed",
      "VNC SSH tunnel did not open the local port",
      {
        cause: lastError,
        details: { localPort },
      },
    );
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
