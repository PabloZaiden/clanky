/**
 * Core manager for task-scoped SSH port forwards.
 */

import { spawn } from "node:child_process";
import type { PortForward } from "../../types";
import { getWorkspace, touchWorkspace } from "../../persistence/workspaces";
import {
  deletePortForward,
  getPortForward,
  listPortForwardsByTaskId,
  listPortForwardsBySshSessionId,
  listPortForwardsByStatuses,
  listReservedPortForwardLocalPortsForMaintenance,
  savePortForward,
} from "../../persistence/forwarded-ports";
import { loadTask } from "../../persistence/tasks";
import { createLogger } from "../logger";
import { sshSessionEventEmitter } from "../event-emitter";
import {
  LOCAL_PORT_RESERVATION_RETRY_LIMIT,
  REMOTE_FORWARD_HOST,
  RESERVED_STATUSES,
  STOP_TIMEOUT_MS,
} from "./constants";
import type { LocalPortAllocator, PortForwardSpawnFactory, RuntimeHandle } from "./types";
import { ensureLocalPortAvailable } from "./port-allocator";
import { buildSpawnConfig, isProcessAlive, waitForProcessExit, waitForProcessStartup } from "./process-lifecycle";
import {
  assertWorkspaceRemotePortAvailable,
  buildDuplicateRemotePortError,
  isActiveLocalPortConstraintError,
  isActiveWorkspaceRemotePortConstraintError,
} from "./constraint-helpers";
import { requireCurrentUser, runWithCurrentUser } from "../user-context";

const log = createLogger("core:port-forward-manager");
const DATABASE_NOT_INITIALIZED_MESSAGE = "Database not initialized. Call initializeDatabase() first.";

function isDatabaseNotInitializedError(error: unknown): boolean {
  return error instanceof Error && error.message === DATABASE_NOT_INITIALIZED_MESSAGE;
}

export class PortForwardManager {
  private readonly runtimeHandles = new Map<string, RuntimeHandle>();
  private spawnFactory: PortForwardSpawnFactory = ({ command, args, env }) => spawn(command, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  private localPortAllocator: LocalPortAllocator = ensureLocalPortAvailable;
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

    const initializing = this.reconcilePersistedForwards();
    this.initializingByUserId.set(user.id, initializing);
    try {
      await initializing;
      this.initializedUserIds.add(user.id);
    } finally {
      this.initializingByUserId.delete(user.id);
    }
  }

  async listTaskPortForwards(taskId: string): Promise<PortForward[]> {
    await this.initialize();
    return await listPortForwardsByTaskId(taskId);
  }

  async getPortForward(id: string): Promise<PortForward | null> {
    await this.initialize();
    return await getPortForward(id);
  }

  async createTaskPortForward(options: {
    taskId: string;
    remotePort: number;
  }): Promise<PortForward> {
    await this.initialize();

    const task = await loadTask(options.taskId);
    if (!task) {
      throw new Error(`Task not found: ${options.taskId}`);
    }

    const workspace = await getWorkspace(task.config.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${task.config.workspaceId}`);
    }

    await assertWorkspaceRemotePortAvailable(workspace.id, options.remotePort);
    await touchWorkspace(workspace.id);
    const { sshSessionManager } = await import("../ssh-session-manager");
    const linkedSession = await sshSessionManager.getSessionByTaskId(options.taskId);
    const forward = await this.reserveStartingForward({
      taskId: options.taskId,
      workspaceId: workspace.id,
      sshSessionId: linkedSession?.config.id,
      remoteHost: REMOTE_FORWARD_HOST,
      remotePort: options.remotePort,
    });
    this.emitForwardCreated(forward);

    try {
      const child = this.spawnForwardProcess(workspace, forward);
      this.attachRuntimeHandle(forward, child);
      await waitForProcessStartup(child);

      const activeForward: PortForward = {
        config: {
          ...forward.config,
          updatedAt: new Date().toISOString(),
        },
        state: {
          status: "active",
          pid: child.pid ?? undefined,
          connectedAt: new Date().toISOString(),
        },
      };
      await savePortForward(activeForward);
      this.emitForwardUpdated(activeForward);
      return activeForward;
    } catch (error) {
      const failedForward: PortForward = {
        config: {
          ...forward.config,
          updatedAt: new Date().toISOString(),
        },
        state: {
          status: "failed",
          error: String(error),
        },
      };
      this.runtimeHandles.delete(forward.config.id);
      await savePortForward(failedForward);
      this.emitForwardUpdated(failedForward);
      throw error;
    }
  }

  async deletePortForward(id: string): Promise<boolean> {
    await this.initialize();
    const forward = await getPortForward(id);
    if (!forward) {
      return false;
    }

    await this.stopForward(forward);
    const deleted = await deletePortForward(id);
    if (deleted) {
      sshSessionEventEmitter.emit({
        type: "ssh_session.port_forward.deleted",
        portForwardId: id,
        taskId: forward.config.taskId,
        sshSessionId: forward.config.sshSessionId,
        timestamp: new Date().toISOString(),
      });
    }
    return deleted;
  }

  async deleteForwardsByTaskId(taskId: string): Promise<void> {
    const forwards = await listPortForwardsByTaskId(taskId);
    for (const forward of forwards) {
      await this.deletePortForward(forward.config.id);
    }
  }

  async deleteForwardsBySshSessionId(sshSessionId: string): Promise<void> {
    const forwards = await listPortForwardsBySshSessionId(sshSessionId);
    for (const forward of forwards) {
      await this.deletePortForward(forward.config.id);
    }
  }

  setSpawnFactoryForTesting(factory: PortForwardSpawnFactory | null): void {
    this.spawnFactory = factory ?? (({ command, args, env }) => spawn(command, args, {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    }));
    this.runtimeHandles.clear();
    this.initializedUserIds.clear();
    this.initializingByUserId.clear();
  }

  setLocalPortAllocatorForTesting(allocator: LocalPortAllocator | null): void {
    this.localPortAllocator = allocator ?? ensureLocalPortAvailable;
  }

  private spawnForwardProcess(workspace: Parameters<typeof buildSpawnConfig>[0], forward: PortForward) {
    const spawnConfig = buildSpawnConfig(workspace, forward);
    log.debug("Starting port forward", {
      portForwardId: forward.config.id,
      taskId: forward.config.taskId,
      localPort: forward.config.localPort,
      remoteHost: forward.config.remoteHost,
      remotePort: forward.config.remotePort,
      command: spawnConfig.command,
    });
    return this.spawnFactory(spawnConfig);
  }

  private attachRuntimeHandle(forward: PortForward, child: RuntimeHandle["child"]): void {
    const runtimeHandle: RuntimeHandle = {
      child,
      deleting: false,
      user: requireCurrentUser(),
    };
    this.runtimeHandles.set(forward.config.id, runtimeHandle);

    child.once("exit", (code, signal) => {
      const handle = this.runtimeHandles.get(forward.config.id);
      const deleting = handle?.deleting ?? false;
      this.runtimeHandles.delete(forward.config.id);
      if (handle) {
        void runWithCurrentUser(handle.user, () => this.handleUnexpectedExit(forward.config.id, deleting, code, signal));
      }
    });
  }

  private async handleUnexpectedExit(
    portForwardId: string,
    deleting: boolean,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    let forward: PortForward | null;
    try {
      forward = await getPortForward(portForwardId);
    } catch (error) {
      if (isDatabaseNotInitializedError(error)) {
        return;
      }
      throw error;
    }
    if (!forward || deleting || !RESERVED_STATUSES.has(forward.state.status)) {
      return;
    }

    const nextStatus: PortForward = {
      config: {
        ...forward.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        status: "failed",
        error: `SSH tunnel exited unexpectedly (code=${String(code)}, signal=${String(signal)})`,
      },
    };
    await savePortForward(nextStatus);
    this.emitForwardUpdated(nextStatus);
  }

  private async stopForward(forward: PortForward): Promise<void> {
    const stoppingForward: PortForward = {
      config: {
        ...forward.config,
        updatedAt: new Date().toISOString(),
      },
      state: {
        ...forward.state,
        status: "stopping",
      },
    };
    await savePortForward(stoppingForward);
    this.emitForwardUpdated(stoppingForward);

    const handle = this.runtimeHandles.get(forward.config.id);
    if (handle) {
      handle.deleting = true;
      try {
        handle.child.kill("SIGTERM");
      } catch (error) {
        log.warn("Failed to send SIGTERM to managed port-forward process during cleanup", {
          forwardId: forward.config.id,
          pid: handle.child.pid,
          error: String(error),
        });
      }
      await waitForProcessExit(handle.child, STOP_TIMEOUT_MS);
      if (handle.child.exitCode === null) {
        try {
          handle.child.kill("SIGKILL");
        } catch (error) {
          log.warn("Failed to send SIGKILL to managed port-forward process during cleanup", {
            forwardId: forward.config.id,
            pid: handle.child.pid,
            error: String(error),
          });
        }
      }
      this.runtimeHandles.delete(forward.config.id);
      return;
    }

    if (forward.state.pid && isProcessAlive(forward.state.pid)) {
      try {
        process.kill(forward.state.pid, "SIGTERM");
      } catch (error) {
        log.warn("Failed to stop external port-forward process during cleanup", {
          forwardId: forward.config.id,
          pid: forward.state.pid,
          error: String(error),
        });
      }
    }
  }

  private async getReservedLocalPorts(): Promise<Set<number>> {
    return await listReservedPortForwardLocalPortsForMaintenance(["starting", "active", "stopping"]);
  }

  private async reserveStartingForward(options: {
    taskId: string;
    workspaceId: string;
    sshSessionId?: string;
    remoteHost: string;
    remotePort: number;
  }): Promise<PortForward> {
    for (let attempt = 0; attempt < LOCAL_PORT_RESERVATION_RETRY_LIMIT; attempt++) {
      const reservedPorts = await this.getReservedLocalPorts();
      const localPort = await this.localPortAllocator(reservedPorts);
      const now = new Date().toISOString();
      const forward: PortForward = {
        config: {
          id: crypto.randomUUID(),
          taskId: options.taskId,
          workspaceId: options.workspaceId,
          sshSessionId: options.sshSessionId,
          remoteHost: options.remoteHost,
          remotePort: options.remotePort,
          localPort,
          createdAt: now,
          updatedAt: now,
        },
        state: {
          status: "starting",
        },
      };

      try {
        await savePortForward(forward);
        return forward;
      } catch (error) {
        if (isActiveWorkspaceRemotePortConstraintError(error)) {
          throw buildDuplicateRemotePortError(options.remotePort);
        }
        if (!isActiveLocalPortConstraintError(error) || attempt === LOCAL_PORT_RESERVATION_RETRY_LIMIT - 1) {
          throw error;
        }
        log.debug("Retrying port-forward reservation after local port conflict", {
          taskId: options.taskId,
          remoteHost: options.remoteHost,
          remotePort: options.remotePort,
          localPort,
          attempt: attempt + 1,
        });
      }
    }

    throw new Error("Failed to reserve a unique local port for forwarding");
  }

  private async reconcilePersistedForwards(): Promise<void> {
    const forwards = await listPortForwardsByStatuses(["starting", "active", "stopping"]);
    for (const forward of forwards) {
      if (forward.state.pid && isProcessAlive(forward.state.pid)) {
        try {
          process.kill(forward.state.pid, "SIGTERM");
        } catch {
          // Ignore kill failures; stale records will still be marked stopped below.
        }
      }

      const reconciledForward: PortForward = {
        config: {
          ...forward.config,
          updatedAt: new Date().toISOString(),
        },
        state: {
          status: "stopped",
          error: "Port forward was reset during server startup and must be recreated",
        },
      };
      await savePortForward(reconciledForward);
      this.emitForwardUpdated(reconciledForward);
    }
  }

  private emitForwardCreated(forward: PortForward): void {
    sshSessionEventEmitter.emit({
      type: "ssh_session.port_forward.created",
      portForwardId: forward.config.id,
      taskId: forward.config.taskId,
      sshSessionId: forward.config.sshSessionId,
      forward,
      timestamp: forward.config.createdAt,
    });
  }

  private emitForwardUpdated(forward: PortForward): void {
    sshSessionEventEmitter.emit({
      type: "ssh_session.port_forward.updated",
      portForwardId: forward.config.id,
      taskId: forward.config.taskId,
      sshSessionId: forward.config.sshSessionId,
      forward,
      timestamp: forward.config.updatedAt,
    });
    sshSessionEventEmitter.emit({
      type: "ssh_session.port_forward.status",
      portForwardId: forward.config.id,
      taskId: forward.config.taskId,
      sshSessionId: forward.config.sshSessionId,
      status: forward.state.status,
      error: forward.state.error,
      timestamp: forward.config.updatedAt,
    });
  }
}

export const portForwardManager = new PortForwardManager();
