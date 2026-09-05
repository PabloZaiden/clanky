/**
 * Interactive terminal adapter around the established SSH bridge.
 */

import { terminalSessionManager } from "../terminal-session-manager";
import { SshTerminalBridge } from "../ssh-terminal-bridge";
import type {
  InteractiveTerminalCallbacks,
  InteractiveTerminalConnection,
  InteractiveTerminalConnectResult,
} from "./interactive-terminal-connection";

export class SshInteractiveTerminalConnection implements InteractiveTerminalConnection {
  private readonly bridge: SshTerminalBridge;

  constructor(
    private readonly sessionId: string,
    callbacks: InteractiveTerminalCallbacks,
    credentialToken?: string,
  ) {
    this.bridge = new SshTerminalBridge(sessionId, {
      onOutput: callbacks.onOutput,
      onClipboardCopy: callbacks.onClipboardCopy,
      onExit: (code, signal) => callbacks.onExit?.(code, signal),
      onError: callbacks.onError,
    }, {
      credentialToken,
    });
  }

  async connect(): Promise<InteractiveTerminalConnectResult> {
    await this.bridge.connect();
    const session = await terminalSessionManager.getSession(this.sessionId);
    if (!session) {
      throw new Error("Terminal session was deleted while connecting.");
    }
    return {
      runtimeConnectionMode: session.state.runtimeConnectionMode
        ?? session.config.connectionMode,
      ...(session.state.notice ? { notice: session.state.notice } : {}),
    };
  }

  sendInput(data: string): void {
    this.bridge.sendInput(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    await this.bridge.resize(cols, rows);
  }

  async dispose(): Promise<void> {
    await this.bridge.dispose();
  }
}
