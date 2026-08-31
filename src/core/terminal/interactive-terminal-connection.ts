/**
 * Transport-neutral interactive terminal connection contract.
 */

import type { TerminalConnectionMode } from "@/shared/terminal-session";

export interface InteractiveTerminalCallbacks {
  onOutput: (chunk: string) => void;
  onClipboardCopy?: (text: string) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onError?: (error: Error) => void;
}

export interface InteractiveTerminalConnectResult {
  runtimeConnectionMode: TerminalConnectionMode;
  notice?: string;
}

export interface InteractiveTerminalConnection {
  connect(): Promise<InteractiveTerminalConnectResult>;
  sendInput(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  dispose(): Promise<void>;
}
